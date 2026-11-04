import asyncio
import os
from collections import Counter
from datetime import datetime, timezone
from hashlib import file_digest
from ipaddress import IPv4Address, ip_address, ip_network
from pathlib import Path

from aiohttp import WSMsgType, web

STATE = Path("/state")
ARTIFACTS = Path("/lab/artifacts")
PREFIX = "/wasm-lab"
MAX_CONSENSUS = 8 * 1024 * 1024
MAX_BYTES = 4 * 1024 * 1024
ORIGIN = web.AppKey("origin", str)


class Directory:
    """Use only the local consensus published by the signature-checking process."""

    def __init__(self, path):
        self.path = path
        self.signature = None
        self.dates = {}
        self.endpoints = set()

    def current(self, now):
        try:
            with self.path.open("rb") as file:
                stat = os.fstat(file.fileno())
                signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
                if signature != self.signature:
                    data = file.read(MAX_CONSENSUS + 1)
                    if len(data) > MAX_CONSENSUS:
                        return False
                    dates, endpoints = {}, set()
                    for line in data.decode("ascii").splitlines():
                        if line.startswith(("valid-after ", "valid-until ")):
                            key, value = line.split(" ", 1)
                            dates[key] = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                        elif line.startswith("r "):
                            host, port = line.split()[5:7]
                            if IPv4Address(host).is_global and not IPv4Address(host).is_multicast:
                                endpoints.add((host, int(port)))
                    self.dates, self.endpoints, self.signature = dates, endpoints, signature
            return bool(self.endpoints) and self.dates["valid-after"] <= now < self.dates["valid-until"]
        except (OSError, KeyError, ValueError):
            return False


class Limits:
    def __init__(self):
        self.window = -1
        self.opens = Counter()
        self.active = Counter()
        self.total = 0

    def acquire(self, key, now):
        window = int(now // 60)
        if window != self.window:
            self.window = window
            self.opens.clear()
        if (self.total >= 24 or self.active[key] >= 6 or self.opens[key] >= 24
                or (key not in self.opens and len(self.opens) >= 1024)):
            return False
        self.total += 1
        self.active[key] += 1
        self.opens[key] += 1
        return True

    def release(self, key):
        self.total -= 1
        self.active[key] -= 1
        if not self.active[key]:
            del self.active[key]


def parse_target(value):
    host, port = value.split(":")
    address = IPv4Address(host)
    number = int(port)
    if not address.is_global or address.is_multicast or not 0 < number <= 65535:
        raise ValueError("Invalid relay endpoint")
    return str(address), number


def make_app(state=STATE, artifacts=ARTIFACTS, origin=None):
    app = web.Application()
    app[ORIGIN] = origin or os.environ["LAB_ORIGIN"]
    directory = Directory(state / "consensus-microdesc.txt")
    limits = Limits()
    wasm = artifacts / "tor_js_bg.wasm"
    wasm_version = None
    if wasm.is_file():
        with wasm.open("rb") as file:
            wasm_version = file_digest(file, "sha256").hexdigest()

    def snapshot_available():
        return directory.current(datetime.now(timezone.utc))

    async def asset(request):
        name = request.match_info["name"]
        if name == "client.js":
            return web.FileResponse(artifacts / name, headers={
                "Content-Type": "text/javascript", "Cache-Control": "no-cache",
            })
        if name == "tor_js_bg.wasm":
            version = request.query.get("v")
            if version is not None and version != wasm_version:
                raise web.HTTPNotFound()
            cache = "public, max-age=31536000, immutable" if version is not None else "no-cache"
            return web.FileResponse(wasm, headers={"Content-Type": "application/wasm", "Cache-Control": cache})
        raise web.HTTPNotFound()

    async def bootstrap(_request):
        path = state / "bootstrap.zip.zst"
        if snapshot_available() and path.is_file() and 0 < path.stat().st_size <= MAX_CONSENSUS:
            return web.FileResponse(path, headers={
                "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
            })
        raise web.HTTPServiceUnavailable(text="Anyone bootstrap snapshot is unavailable.")

    async def relay(request):
        if request.headers.get("Origin") != app[ORIGIN]:
            raise web.HTTPForbidden()
        try:
            remote = ip_address(request.headers.get("X-Lab-Client-IP", ""))
            if remote.version == 6 and remote.ipv4_mapped:
                remote = remote.ipv4_mapped
            key = ip_network((remote, 64 if remote.version == 6 else 32), strict=False)
            targets = request.query.getall("target", [])
            if len(targets) != 1:
                raise ValueError()
            target = parse_target(targets[0])
        except ValueError:
            raise web.HTTPBadRequest(text="Invalid relay request.")

        if not snapshot_available():
            raise web.HTTPServiceUnavailable(text="Anyone relay directory is unavailable.")
        if target not in directory.endpoints:
            raise web.HTTPForbidden(text="Relay endpoint is outside the Anyone directory.")
        if not limits.acquire(key, asyncio.get_running_loop().time()):
            raise web.HTTPTooManyRequests(text="Relay capacity reached.")

        ws = web.WebSocketResponse(max_msg_size=65_536, compress=False, heartbeat=30)
        try:
            await ws.prepare(request)
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection(*target), 8)
            except (OSError, TimeoutError):
                await ws.close(code=1013, message=b"Relay connection failed")
                return ws

            remaining = MAX_BYTES

            def charge(size):
                nonlocal remaining
                remaining -= size
                if remaining < 0:
                    raise ValueError("Byte limit reached")

            async def upstream():
                finished = False
                async for message in ws:
                    if message.type == WSMsgType.BINARY and not finished:
                        charge(len(message.data))
                        writer.write(message.data)
                        await writer.drain()
                    elif message.type == WSMsgType.TEXT and message.data == "fin" and not finished:
                        finished = True
                        writer.write_eof()
                    else:
                        raise ValueError("Invalid relay data")

            async def downstream():
                while chunk := await reader.read(32_768):
                    charge(len(chunk))
                    await ws.send_bytes(chunk)

            jobs = []
            try:
                await ws.send_str("ready")
                jobs = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
                done, _ = await asyncio.wait(jobs, timeout=150, return_when=asyncio.FIRST_COMPLETED)
                for job in done:
                    job.result()
            except ValueError:
                await ws.close(code=1008, message=b"Relay policy limit")
            except OSError:
                pass
            finally:
                for job in jobs:
                    job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
                writer.close()
                await ws.close()
        finally:
            limits.release(key)
        return ws

    app.router.add_get(PREFIX + "/bootstrap", bootstrap)
    app.router.add_get(PREFIX + "/relay", relay)
    app.router.add_get(PREFIX + "/{name:client\\.js|tor_js_bg\\.wasm}", asset)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=8080, access_log=None)
