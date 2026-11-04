import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import AioHTTPTestCase

from server import Limits, make_app

ORIGIN = "https://lab.example"
HEADERS = {"Origin": ORIGIN, "X-Lab-Client-IP": "198.51.100.123"}


class BridgePolicy(AioHTTPTestCase):
    async def get_application(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.write_directory(datetime.now(timezone.utc))
        (self.state / "bootstrap.zip.zst").write_bytes(b"snapshot")
        return make_app(state=self.state, artifacts=self.state, origin=ORIGIN)

    def write_directory(self, now):
        (self.state / "consensus-microdesc.txt").write_text(
            f"valid-after {now - timedelta(hours=1):%Y-%m-%d %H:%M:%S}\n"
            f"valid-until {now + timedelta(hours=1):%Y-%m-%d %H:%M:%S}\n"
            "r example abc 2026-11-04 12:00:00 8.8.8.8 9001 0\n"
            "r private def 2026-11-04 12:00:00 127.0.0.1 9001 0\n",
            encoding="ascii",
        )

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
        async with self.client.get("/wasm-lab/bootstrap") as response:
            self.assertEqual(response.status, 200)
        self.write_directory(datetime.now(timezone.utc) - timedelta(hours=2))
        with patch("server.asyncio.open_connection") as dial:
            async with self.client.get("/wasm-lab/relay?target=8.8.8.8:9001", headers=HEADERS) as response:
                self.assertEqual(response.status, 503)
            dial.assert_not_called()
        async with self.client.get("/wasm-lab/bootstrap") as response:
            self.assertEqual(response.status, 503)


class BridgeLimits(unittest.TestCase):
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
