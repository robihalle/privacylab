# Anyone Privacy Lab — Gateway

This adapter runs an actual HTTPS request through a separate native `anyone-rust` client's SOCKS proxy. It is not a WASM browser client. No live gateway was provisioned as part of the Site build.

## Requirements

A Linux server with Docker Compose, outbound access to the Anyone network and HTTPS, plus a hostname with HTTPS reverse proxy. The Sites runtime cannot host this native client. The server operator remains a trusted party.

## Set up

1. Read https://anyone.io/terms and decide whether to accept them. If accepted, create a local `.env` beside compose.yaml with `ANYONE_TERMS_FLAG=--agree-to-terms` and `GATEWAY_TOKEN=<random-secret>`. Generate a token using `openssl rand -hex 32`. Never commit or share the file.
2. Run `docker compose up -d --build`. The first bootstrap may take time. Inspect `docker compose logs anyone`. The upstream image is a moving `main` tag; pin a reviewed image digest for a stable deployment.
3. Put an HTTPS reverse proxy in front of `127.0.0.1:8080`. Do not expose SOCKS to the Internet. A Caddy site can use `reverse_proxy 127.0.0.1:8080`. Configure your actual hostname and limit the `/v1/test` endpoint to a reasonable request rate. Do not log Authorization headers or request bodies.
4. In Sites set `ANYONE_GATEWAY_URL=https://your-gateway.example` and `ANYONE_GATEWAY_TOKEN` to the matching token. Mark the token as secret, then redeploy the Site. The URL must use HTTPS. Do not paste the token into browser code.
5. Open the Site and choose Anyone-Vergleich → Beide Wege testen. There must be an actual successful gateway response; configuration alone is not a health check.

## Behaviour and evidence

- Only POST /v1/test is accepted; it requires bearer authentication.
- Accepts a random test ID, never a destination URL. The sole destination is https://httpbingo.org/anything/<test-id>.
- Uses `socks5h://anyone:9150` for proxy-side DNS and disables environment proxy inheritance. There is no direct-connection fallback and redirects are rejected.
- Validates the echoed test ID and IP format. Returns only nonce, IP, duration, and the declared transport.
- Maximum three concurrent outbound measurements per process. Configure request-rate limiting at the HTTPS reverse proxy for public deployments.
- No application request logs or result database. The client, hosting provider and target service may retain operational logs.
- The Site treats these as gateway-reported measurements. No independent circuit attestation or exit membership lookup is implemented. An IP difference alone is not a proof of Anyone routing.
- Timings differ: direct is browser-to-target, Anyone is gateway-through-SOCKS-to-target. The Site report also records server-side gateway roundtrip duration.

## Local checks

With the requirements installed, run `python -m unittest test_gateway.py`. These tests mock the network to check that the adapter always uses SOCKS, rejects mismatched echoes and never retries directly. They do not prove live network operation.

## Before broad public release

Test bootstrap, real traffic, timeout behaviour, DNS resolution through SOCKS, and outbound-only-through-Anyone enforcement on the host. Pin the upstream client image, configure proxy rate limits and check the target service's usage expectations.
