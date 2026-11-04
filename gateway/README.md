# Anyone Privacy Lab Gateway

The gateway is the internal Python adapter in the [single-LXC stack](../docs/proxmox-lxc.md). The website calls it at `http://gateway:8080`, and the adapter uses the native client at `socks5h://anyone:9150`. Both services are reachable within Docker, with no published ports.

- `POST /v1/test` requires a bearer token and a test ID. It always uses `https://httpbingo.org/anything/<test-id>` as its destination.
- The gateway resolves DNS through SOCKS, ignores proxy environment variables, and rejects redirects, mismatched test IDs, and invalid IP responses.
- The gateway's internal Docker network blocks direct external connections. The Anyone client has a separate network for outbound traffic.
- Each process can run up to three tests concurrently. The app keeps no access log or server-side results.
- The gateway measures the request through SOCKS to the test endpoint. The web server also records its own round-trip time to the gateway.

The Python tests use simulated network responses. The [live test](../docs/proxmox-lxc.md#4-run-a-live-test) checks the full path after installation.
