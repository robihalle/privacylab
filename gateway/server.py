"""Fixed-target diagnostic adapter. Never accepts destination URLs."""
import hmac
import ipaddress
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import requests

TOKEN = os.environ.get('GATEWAY_TOKEN', '')
SOCKS_URL = 'socks5h://anyone:9150'
TARGET = 'https://httpbingo.org/anything/'
SLOTS = threading.BoundedSemaphore(3)

def measure(nonce):
    start = time.monotonic()
    with requests.Session() as session:
        session.trust_env = False
        response = session.get(TARGET + nonce, proxies={'http': SOCKS_URL, 'https': SOCKS_URL}, timeout=(15, 25), allow_redirects=False)
        if response.status_code != 200:
            raise ValueError('Unexpected target response')
        data = response.json()
    if data.get('url') != TARGET + nonce:
        raise ValueError('Echo mismatch')
    # An unexpected multi-address forwarding chain must not be called an exit IP.
    ip = str(ipaddress.ip_address(data['origin'].strip()))
    return {'nonce': nonce, 'ip': ip, 'elapsedMs': round((time.monotonic()-start)*1000), 'transport':'anyone-rust-socks5h'}

class Handler(BaseHTTPRequestHandler):
    server_version = 'PrivacyLab'
    def log_message(self, *_):
        pass  # No application-level IP or request logs.
    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(raw)
    def do_POST(self):
        if self.path != '/v1/test':
            return self.reply(404, {'error':'not_found'})
        supplied = self.headers.get('Authorization','')
        if not TOKEN or not hmac.compare_digest(supplied, 'Bearer '+TOKEN):
            return self.reply(401, {'error':'unauthorized'})
        try:
            length = int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 256:
                return self.reply(413, {'error':'body_size'})
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(length))
            nonce = data.get('nonce','')
            if not isinstance(nonce,str) or not re.fullmatch(r'[a-f0-9-]{36}', nonce):
                raise ValueError()
        except (ValueError, TypeError, TimeoutError):
            return self.reply(400, {'error':'invalid_request'})
        if not SLOTS.acquire(blocking=False):
            return self.reply(429, {'error':'busy'})
        try:
            self.reply(200, measure(nonce))
        except (requests.RequestException, ValueError, KeyError, TypeError):
            self.reply(502, {'error':'network_test_failed'})
        finally:
            SLOTS.release()
    def do_GET(self):
        self.reply(405, {'error':'method_not_allowed'})

if __name__ == '__main__':
    if len(TOKEN) < 32:
        raise SystemExit('GATEWAY_TOKEN must contain at least 32 characters')
    ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
