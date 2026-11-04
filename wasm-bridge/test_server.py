import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

from server import Limits, MinuteQuota, make_app, select_encoding

ORIGIN = "https://lab.example"
HEADERS = {"Origin": ORIGIN, "X-Lab-Client-IP": "198.51.100.123"}
FIRST = "1" * 64
SECOND = "2" * 64


class BridgePolicy(AioHTTPTestCase):
    async def get_application(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.write_generation(FIRST, datetime.now(timezone.utc))
        self.publish(FIRST)
        (self.state / "tor_js_bg.wasm").write_bytes(b"wasm fixture")
        (self.state / "tor_js_bg.br.wasm").write_bytes(b"brotli fixture")
        (self.state / "tor_js_bg.gz.wasm").write_bytes(b"gzip fixture")
        (self.state / "client.js").write_bytes(b"client fixture")
        (self.state / "client-worker.js").write_bytes(b"worker fixture")
        return make_app(state=self.state, artifacts=self.state, origin=ORIGIN)

    def write_generation(self, generation, now, relay="8.8.8.8"):
        folder = self.state / "generations" / generation
        folder.mkdir(parents=True)
        (folder / "consensus-microdesc.txt").write_text(
            f"valid-after {now - timedelta(hours=1):%Y-%m-%d %H:%M:%S}\n"
            f"valid-until {now + timedelta(hours=1):%Y-%m-%d %H:%M:%S}\n"
            f"r example abc 2026-11-04 12:00:00 {relay} 9001 0\n"
            "r private def 2026-11-04 12:00:00 127.0.0.1 9001 0\n",
            encoding="ascii",
        )
        (folder / "bootstrap.zip.zst").write_text(generation, encoding="ascii")

    def publish(self, current, previous=None):
        pointer = self.state / "current.tmp"
        pointer.write_text(json.dumps({"current": current, "previous": previous}), encoding="ascii")
        pointer.replace(self.state / "current.json")

    async def test_denies_foreign_origin_unlisted_port_and_private_address(self):
        with patch("server.asyncio.open_connection") as dial:
            cases = [
                ("8.8.8.8:9001", {"X-Lab-Client-IP": HEADERS["X-Lab-Client-IP"]}, 403),
                ("8.8.8.8:443", HEADERS, 403),
                ("127.0.0.1:9001", HEADERS, 400),
            ]
            for target, headers, status in cases:
                async with self.client.get("/wasm-lab/relay", params={"target": target}, headers=headers) as response:
                    self.assertEqual(response.status, status)
            dial.assert_not_called()

    async def test_expired_directory_disables_tunnels_and_bootstrap(self):
        async with self.client.get("/wasm-lab/bootstrap", headers=HEADERS) as response:
            self.assertEqual(response.status, 200)
        self.write_generation(SECOND, datetime.now(timezone.utc) - timedelta(hours=2))
        self.publish(SECOND)
        with patch("server.asyncio.open_connection") as dial:
            async with self.client.get("/wasm-lab/relay?target=8.8.8.8:9001", headers=HEADERS) as response:
                self.assertEqual(response.status, 503)
            dial.assert_not_called()
        async with self.client.get("/wasm-lab/bootstrap", headers=HEADERS) as response:
            self.assertEqual(response.status, 503)
        async with self.client.get("/wasm-lab/health") as response:
            self.assertEqual(response.status, 503)
            self.assertEqual(await response.json(), {"ready": False})

    async def test_bootstrap_and_relay_select_matching_generations(self):
        self.write_generation(SECOND, datetime.now(timezone.utc), "1.1.1.1")
        self.publish(SECOND, FIRST)
        async with self.client.get("/wasm-lab/health") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"ready": True})
        async with self.client.get("/wasm-lab/bootstrap", headers=HEADERS) as response:
            self.assertEqual(response.headers["X-Lab-Snapshot"], SECOND)
            self.assertIn("max-age=10", response.headers["Cache-Control"])
            self.assertEqual(await response.text(), SECOND)
            etag = response.headers["ETag"]
        async with self.client.get("/wasm-lab/bootstrap", headers={**HEADERS, "If-None-Match": etag}) as response:
            self.assertEqual(response.status, 304)
            self.assertEqual(response.headers["X-Lab-Snapshot"], SECOND)
        with patch("server.asyncio.open_connection", side_effect=OSError) as dial:
            path = "/wasm-lab/relay?target=8.8.8.8:9001"
            async with self.client.get(path, headers=HEADERS) as response:
                self.assertEqual(response.status, 403)
            socket = await self.client.ws_connect(path + "&generation=" + FIRST, headers=HEADERS)
            self.assertEqual((await socket.receive()).data, 1013)
            dial.assert_awaited_once_with("8.8.8.8", 9001)

    async def test_unpublished_generation_cannot_open_relay(self):
        self.write_generation(SECOND, datetime.now(timezone.utc))
        path = "/wasm-lab/relay?target=8.8.8.8:9001"
        with patch("server.asyncio.open_connection") as dial:
            async with self.client.get(path + "&generation=" + SECOND, headers=HEADERS) as response:
                self.assertEqual(response.status, 503)
            async with self.client.get(path + "&generation=../../", headers=HEADERS) as response:
                self.assertEqual(response.status, 400)
            dial.assert_not_called()

    async def test_invalid_websocket_handshake_spends_no_tunnel_quota(self):
        with patch("server.Limits.acquire") as acquire:
            async with self.client.get("/wasm-lab/relay?target=8.8.8.8:9001", headers=HEADERS) as response:
                self.assertEqual(response.status, 400)
            acquire.assert_not_called()

    async def test_download_quota_is_separate_from_tunnels(self):
        def admit_tunnels_only(quota, _key, _now):
            return quota.global_limit is None

        with (patch("server.MinuteQuota.charge", autospec=True, side_effect=admit_tunnels_only),
              patch("server.asyncio.open_connection", side_effect=OSError) as dial):
            async with self.client.get("/wasm-lab/bootstrap", headers=HEADERS) as response:
                self.assertEqual(response.status, 429)
                self.assertEqual(response.headers["Retry-After"], "60")
            socket = await self.client.ws_connect("/wasm-lab/relay?target=8.8.8.8:9001", headers=HEADERS)
            self.assertEqual((await socket.receive()).data, 1013)
            dial.assert_awaited_once()

    async def test_only_the_matching_wasm_version_is_immutable(self):
        path = "/wasm-lab/tor_js_bg.wasm"
        async with self.client.get(path, headers={**HEADERS, "Accept-Encoding": "identity"}) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-cache")
        async with self.client.get(path, headers=HEADERS, params={"v": "old"}) as response:
            self.assertEqual(response.status, 404)
        async with self.client.get(path, headers={**HEADERS, "Accept-Encoding": "identity"},
                                   params={"v": sha256(b"wasm fixture").hexdigest()}) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("immutable", response.headers["Cache-Control"])

    async def test_precompressed_wasm_and_worker_javascript(self):
        path = "/wasm-lab/tor_js_bg.wasm"
        async with self.client.get(path, headers={**HEADERS, "Accept-Encoding": "gzip"},
                                   auto_decompress=False) as response:
            self.assertEqual(response.headers["Content-Type"], "application/wasm")
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertEqual(response.headers["Vary"], "Accept-Encoding")
            self.assertEqual(await response.read(), b"gzip fixture")
        async with self.client.get(path, headers={**HEADERS, "Accept-Encoding": "gzip;q=0, identity"},
                                   auto_decompress=False) as response:
            self.assertNotIn("Content-Encoding", response.headers)
            self.assertEqual(response.headers["Vary"], "Accept-Encoding")
            self.assertEqual(await response.read(), b"wasm fixture")
        async with self.client.get("/wasm-lab/client-worker.js", headers=HEADERS) as response:
            self.assertEqual(response.headers["Content-Type"], "text/javascript")
            self.assertEqual(await response.read(), b"worker fixture")

    async def test_request_with_body_is_rejected(self):
        async with self.client.get("/wasm-lab/bootstrap", headers=HEADERS, data=b"x") as response:
            self.assertEqual(response.status, 400)


class BridgeLimits(unittest.TestCase):
    def test_global_download_rate_limit(self):
        quota = MinuteQuota(2, global_limit=3)
        self.assertTrue(quota.charge("a", 61))
        self.assertTrue(quota.charge("a", 61))
        self.assertFalse(quota.charge("a", 61))
        self.assertTrue(quota.charge("b", 61))
        self.assertFalse(quota.charge("c", 61))
        self.assertTrue(quota.charge("c", 121))

    def test_concurrency_and_rate_limits(self):
        limits = Limits()
        for _ in range(6):
            self.assertTrue(limits.acquire("client", 61))
        self.assertFalse(limits.acquire("client", 61))
        for _ in range(6):
            limits.release("client")
        for _ in range(18):
            self.assertTrue(limits.acquire("client", 61))
            limits.release("client")
        self.assertFalse(limits.acquire("client", 61))
        self.assertTrue(limits.acquire("client", 121))


class Encodings(unittest.TestCase):
    def test_explicit_quality_and_fallback(self):
        variants = ("br", "gzip")
        self.assertEqual(select_encoding("gzip, br", variants), "br")
        self.assertEqual(select_encoding("gzip, br;q=0", variants), "gzip")
        self.assertEqual(select_encoding("gzip;q=0.8, br;q=0.3", variants), "gzip")
        self.assertEqual(select_encoding("br;q=0", variants), "identity")
        with self.assertRaises(web.HTTPNotAcceptable):
            select_encoding("br;q=0, gzip;q=0, identity;q=0", variants)
