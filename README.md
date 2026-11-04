# Anyone Privacy Lab

A standalone tech demo for the Anyone network. Compare the source IP an HTTPS endpoint sees when a request comes directly from your browser and when it goes through the native Anyone Rust client.

## Install on Proxmox

The [installation guide](docs/proxmox-lxc.md) walks you through creating a Debian 13 LXC on amd64 and running a live test. Docker Compose starts the website, Caddy, the gateway, and the Anyone client in a single unprivileged LXC. Caddy is the only service with published ports. The gateway and SOCKS proxy stay on the internal Docker network.

The direct test sends a request from your browser to `httpbingo.org`. For the Anyone test, the website forwards a separate test ID to the internal gateway. The gateway requests the same fixed HTTPS endpoint through SOCKS, with DNS resolution handled by the proxy. The tab pairs the results locally. The website, gateway, and native Rust client all run inside the LXC. The interface also describes a planned browser WASM path, which is outside the live comparison.

## Development

Use Node.js 24 and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. The Anyone comparison requires the Compose stack.

```sh
pnpm build
node --test tests/privacy-api.test.mjs
python3 -m venv /tmp/privacylab-venv
/tmp/privacylab-venv/bin/pip install -r gateway/requirements.txt
/tmp/privacylab-venv/bin/python -m unittest discover -s gateway -p test_gateway.py
```

The [gateway documentation](gateway/README.md) describes the internal adapter. This project is an independent community demo. It uses the upstream [Anyone Rust client](https://github.com/anyone-protocol/anyone-rust). Third-party code retains its respective license terms.
