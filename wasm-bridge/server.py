import asyncio
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
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
GENERATION = re.compile(r"[0-9a-f]{64}")
QUALITY = re.compile(r"(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)")
SCRIPTS = {"client.js", "client-worker.js"}
RETRY_HEADERS = {"Retry-After": "60", "Cache-Control": "no-store"}


@dataclass(frozen=True)
class Snapshot:
    generation: str
    archive: Path
    valid_after: datetime
    valid_until: datetime
    endpoints: frozenset

    def valid_at(self, now):
        return self.valid_after <= now < self.valid_until


class Directory:
    """Use only immutable generations published by the signature-checking process."""

    def __init__(self, state):
        self.state = state
        self.pointer = None
        self.generations = (None, None)
        self.loaded = {}

    def select(self, now, requested=None):
        try:
            with (self.state / "current.json").open("rb") as file:
                stat = os.fstat(file.fileno())
                signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
                if signature != self.pointer:
                    if stat.st_size > 512:
                        return None
                    document = json.loads(file.read(512))
                    current, previous = document["current"], document.get("previous")
                    if not valid_generation(current) or (previous is not None and not valid_generation(previous)):
                        return None
                    self.generations = (current, previous)
                    self.loaded = {key: item for key, item in self.loaded.items() if key in self.generations}
                    self.pointer = signature
            generation = requested or self.generations[0]
            if not generation or generation not in self.generations:
                return None
            if generation not in self.loaded:
                self.loaded[generation] = self.read_generation(generation)
            snapshot = self.loaded[generation]
            if snapshot.valid_at(now) and 0 < snapshot.archive.stat().st_size <= MAX_CONSENSUS:
                return snapshot
        except (OSError, KeyError, TypeError, ValueError):
            return None
        return None

    def read_generation(self, generation):
        root = self.state / "generations" / generation
        with (root / "consensus-microdesc.txt").open("rb") as file:
            data = file.read(MAX_CONSENSUS + 1)
        if len(data) > MAX_CONSENSUS:
            raise ValueError("Oversized consensus")
        dates, endpoints = {}, set()
        for line in data.decode("ascii").splitlines():
            if line.startswith(("valid-after ", "valid-until ")):
                key, value = line.split(" ", 1)
                dates[key] = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            elif line.startswith("r "):
                host, port = line.split()[5:7]
                address = IPv4Address(host)
                if address.is_global and not address.is_multicast:
                    endpoints.add((host, int(port)))
        if not endpoints:
            raise ValueError("Empty relay directory")
        return Snapshot(generation, root / "bootstrap.zip.zst", dates["valid-after"],
                        dates["valid-until"], frozenset(endpoints))


def valid_generation(value):
    return isinstance(value, str) and GENERATION.fullmatch(value) is not None


class MinuteQuota:
    def __init__(self, per_address, global_limit=None):
        self.per_address = per_address
        self.global_limit = global_limit
        self.window = -1
        self.counts = Counter()
        self.total = 0

    def charge(self, key, now):
        window = int(now // 60)
        if window != self.window:
            self.window = window
            self.counts.clear()
            self.total = 0
        if (self.counts[key] >= self.per_address
                or (self.global_limit is not None and self.total >= self.global_limit)
                or (key not in self.counts and len(self.counts) >= 1024)):
            return False
        self.counts[key] += 1
        self.total += 1
        return True


class Limits:
    def __init__(self):
        self.opens = MinuteQuota(24)
        self.active = Counter()
        self.total = 0

    def acquire(self, key, now):
        if self.total >= 24 or self.active[key] >= 6 or not self.opens.charge(key, now):
            return False
        self.total += 1
        self.active[key] += 1
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


def client_key(request):
    # Only Caddy publishes an ingress port and it overwrites this header.
    try:
        remote = ip_address(request.headers.get("X-Lab-Client-IP", ""))
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid client address.") from None
    if remote.version == 6 and remote.ipv4_mapped:
        remote = remote.ipv4_mapped
    return ip_network((remote, 64 if remote.version == 6 else 32), strict=False)


def select_encoding(header, variants):
    """Negotiate the precompressed representation, respecting explicit exclusions."""
    qualities = {}
    for entry in header.lower().split(","):
        name, separator, parameter = entry.partition(";")
        name = name.strip()
        if not name:
            continue
        quality = 1.0
        if separator:
            key, _, value = parameter.strip().partition("=")
            if key.strip() != "q" or not QUALITY.fullmatch(value.strip()):
                continue
            quality = float(value)
        qualities[name] = min(qualities.get(name, 1.0), quality)

    wildcard = qualities.get("*", 0.0)
    choice = max(variants, key=lambda name: qualities.get(name, wildcard), default=None)
    best = qualities.get(choice, wildcard) if choice else 0.0
    identity = qualities.get("identity", 0.0 if qualities.get("*") == 0 else 1.0)
    if best > 0 and best >= qualities.get("identity", 0.0):
        return choice
    if identity > 0:
        return "identity"
    raise web.HTTPNotAcceptable(headers={"Vary": "Accept-Encoding"})


@web.middleware
async def reject_bodies(request, handler):
    if request.can_read_body or request.content_length:
        raise web.HTTPBadRequest(text="Request bodies are unsupported.")
    return await handler(request)


def make_app(state=STATE, artifacts=ARTIFACTS, origin=None):
    app = web.Application(middlewares=[reject_bodies], handler_args={"auto_decompress": False})
    app[ORIGIN] = origin or os.environ["LAB_ORIGIN"]
    directory = Directory(state)
    limits = Limits()
    downloads = MinuteQuota(32, global_limit=240)
    wasm = artifacts / "tor_js_bg.wasm"
    # The explicit paths keep FileResponse from renegotiating an encoding.
    variants = {
        encoding: path for encoding, path in (
            ("br", artifacts / "tor_js_bg.br.wasm"),
            ("gzip", artifacts / "tor_js_bg.gz.wasm"),
        ) if path.is_file()
    }
    wasm_version = None
    if wasm.is_file():
        with wasm.open("rb") as file:
            wasm_version = file_digest(file, "sha256").hexdigest()

    def limit_downloads(request):
        if not downloads.charge(client_key(request), asyncio.get_running_loop().time()):
            raise web.HTTPTooManyRequests(text="Download capacity reached.", headers=RETRY_HEADERS)

    async def asset(request):
        name = request.match_info["name"]
        if name in SCRIPTS:
            limit_downloads(request)
            return web.FileResponse(artifacts / name, headers={
                "Content-Type": "text/javascript", "Cache-Control": "no-cache",
            })
        if name == "tor_js_bg.wasm":
            version = request.query.get("v")
            if version is not None and version != wasm_version:
                raise web.HTTPNotFound()
            limit_downloads(request)
            cache = "public, max-age=31536000, immutable" if version is not None else "no-cache"
            encoding = select_encoding(",".join(request.headers.getall("Accept-Encoding", [])), variants)
            headers = {"Content-Type": "application/wasm", "Cache-Control": cache, "Vary": "Accept-Encoding"}
            if encoding != "identity":
                headers["Content-Encoding"] = encoding
            return web.FileResponse(variants.get(encoding, wasm), headers=headers)
        raise web.HTTPNotFound()

    async def health(_request):
        ready = (wasm_version is not None and all((artifacts / name).is_file() for name in SCRIPTS)
                 and directory.select(datetime.now(timezone.utc)) is not None)
        return web.json_response({"ready": ready}, status=200 if ready else 503,
                                 headers={"Cache-Control": "no-store"})

    async def bootstrap(request):
        limit_downloads(request)
        now = datetime.now(timezone.utc)
        snapshot = directory.select(now)
        if snapshot is None:
            raise web.HTTPServiceUnavailable(text="Anyone bootstrap snapshot is unavailable.")
        max_age = min(10, int((snapshot.valid_until - now).total_seconds()))
        return web.FileResponse(snapshot.archive, headers={
            "Content-Type": "application/octet-stream",
            "Cache-Control": f"public, max-age={max_age}, must-revalidate",
            "X-Lab-Snapshot": snapshot.generation,
        })

    async def relay(request):
        if request.headers.get("Origin") != app[ORIGIN]:
            raise web.HTTPForbidden()
        try:
            key = client_key(request)
            targets = request.query.getall("target", [])
            generations = request.query.getall("generation", [])
            if len(targets) != 1:
                raise ValueError()
            if generations and (len(generations) != 1 or not valid_generation(generations[0])):
                raise ValueError()
            target = parse_target(targets[0])
        except ValueError:
            raise web.HTTPBadRequest(text="Invalid relay request.")

        snapshot = directory.select(datetime.now(timezone.utc), generations[0] if generations else None)
        if snapshot is None:
            raise web.HTTPServiceUnavailable(text="Anyone relay directory is unavailable.")
        if target not in snapshot.endpoints:
            raise web.HTTPForbidden(text="Relay endpoint is outside the Anyone directory.")
        ws = web.WebSocketResponse(max_msg_size=65_536, compress=False, heartbeat=30)
        if not ws.can_prepare(request).ok:
            raise web.HTTPBadRequest(text="Invalid WebSocket handshake.")
        if not limits.acquire(key, asyncio.get_running_loop().time()):
            raise web.HTTPTooManyRequests(text="Relay capacity reached.", headers=RETRY_HEADERS)

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

    app.router.add_get(PREFIX + "/health", health)
    app.router.add_get(PREFIX + "/bootstrap", bootstrap)
    app.router.add_get(PREFIX + "/relay", relay, allow_head=False)
    app.router.add_get(PREFIX + "/{name:client(?:-worker)?\\.js|tor_js_bg\\.wasm}", asset)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=8080, access_log=None)
