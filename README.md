# Anyone Privacy Lab

An independent community tech demo by Robert: compare what an HTTPS destination sees on a direct browser request and on a request sent through a native Anyone Rust client.

**Site:** https://anyone-privacy-lab.robi90.chatgpt.site (private; owner sign-in required)

## Current status

- Implemented and browser-tested: real direct IP test, echoed request-ID verification, interactive route explanation, request log and JSON report.
- Implemented: server-side gateway adapter, fixed-target authenticated gateway, Docker Compose and setup documentation.
- **Not yet provisioned:** the external Linux gateway running `anyone-rust`. The Anyone comparison remains disabled until the gateway is configured.
- This is **not a WASM client**. The browser runs the interface; the native Rust client runs on the external gateway.

## Architecture

The direct measurement goes from the visitor's browser to `https://httpbingo.org/anything/<random-id>`. The Anyone measurement goes through the Sites Worker, an authenticated HTTPS gateway, the native Rust client's internal SOCKS endpoint and then the same fixed test destination.

The route illustration is schematic. Circuit topology and exit membership are not independently attested. Reported timings cover different paths and are not a controlled benchmark.

## Project layout

| Path | Purpose |
| --- | --- |
| `app/` | Responsive German-language React UI |
| `lib/privacy-api.mjs` | Sites gateway status and test endpoints |
| `worker/index.ts` | Cloudflare Worker entrypoint |
| `gateway/` | Python HTTP adapter, Docker Compose, tests and installation guide |
| `tests/privacy-api.test.mjs` | API validation tests |
| `public/anyone-gateway.zip` | Downloadable copy of the gateway sources |
| `.openai/hosting.json` | Identity of the existing deployed Site |
| `docs/sites-runtime.md` | Supplied Sites runtime and build documentation |

## Local development

Requires Node.js >=22.13.0 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

A fresh clone uses the portable execution profile. See `docs/sites-runtime.md` for platform details. Preserve the supplied Sites Vite integration.

```sh
pnpm exec tsc --noEmit
node --test tests/privacy-api.test.mjs
pnpm build
```

Gateway checks (prefer a virtual environment):

```sh
python -m pip install -r gateway/requirements.txt
python -m unittest discover -s gateway -p test_gateway.py
```

Six API tests and four mocked gateway tests passed during initial development. The direct browser test received a real response and matching test ID. Live Anyone routing has not yet been tested because the external gateway has not been provisioned.

## Connect the Anyone gateway

Follow [gateway/README.md](gateway/README.md). The gateway requires a separate Linux host, Docker, outbound Anyone connectivity and HTTPS. Sites cannot run the native client itself.

Set the following server-side Sites environment values and redeploy:

- `ANYONE_GATEWAY_URL`: HTTPS origin of the gateway.
- `ANYONE_GATEWAY_TOKEN`: secret bearer token matching the gateway configuration.

Keep tokens out of source and browser bundles. The gateway accepts only a fixed diagnostic destination and has no direct-network fallback. Anyone terms must be reviewed and consciously accepted before starting the client.

## Privacy and scope

The external test service sees the request source IP and ordinary HTTPS metadata. The gateway is a trusted intermediary. The application keeps no results database; hosting providers, the client and the test service can maintain operational logs. JSON exports are user-triggered. This demonstration does not protect all browser or device traffic.

## Source and hosting

This repository is a source snapshot of the deployed ChatGPT Site plus project documentation. A GitHub push does **not** automatically deploy the Site. The manifest preserves its existing project ID; use the Sites publication workflow to update that Site. Create a new identity before deploying a separate copy.

Upstream client: https://github.com/anyone-protocol/anyone-rust

This is an independent community project, not an official Anyone Foundation product. Third-party dependencies and retained starter files keep their respective license terms. No new project-wide license grant is made by this repository.
