# Install Anyone Privacy Lab on Proxmox

All services run in one dedicated Debian LXC. The stack includes Caddy, Next.js, the Python gateway, and the native Anyone Rust client. Start with HTTP on your LAN. You can add HTTPS with your own domain later.

## 1. Create the LXC on the Proxmox host

In the Proxmox web interface, download the Debian 13 standard template for **amd64** and select **Create CT**. The default Anyone Rust image is published for Linux amd64.

| Setting | Starting value |
| --- | --- |
| Hostname | `privacy-lab` |
| Container | Unprivileged |
| CPU | 2 cores |
| RAM and swap | 2 GiB RAM and 1 GiB swap |
| Root disk | 12 GiB |
| Network | Static LAN IPv4 address or DHCP reservation, with a gateway and DNS |
| Features | `nesting=1,keyctl=1` |
| Start at boot | Enabled |

Set the features and enable startup at boot while the new container is stopped. Replace `150` with your container ID. Run these commands on the **Proxmox host**.

```sh
CTID=150
pct set "$CTID" --features nesting=1,keyctl=1 --onboot 1
pct start "$CTID"
pct enter "$CTID"
```

## 2. Install Docker inside the LXC

Run the remaining installation commands as `root` **inside the LXC**. Install the packages from the official [Docker APT repository for Debian](https://docs.docker.com/engine/install/debian/).

```sh
apt-get update
apt-get install -y ca-certificates curl git jq nano openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
cat >/etc/apt/sources.list.d/docker.sources <<APT
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
APT

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker.service
docker compose version
docker run --rm hello-world
```

## 3. Start Privacy Lab

```sh
git clone https://github.com/robihalle/privacylab.git /opt/privacylab
cd /opt/privacylab
install -m 0600 deploy/lxc.env.example .env
printf '\nGATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
nano .env
```

In `.env`, set `LAB_BIND_IP` to your LXC's IPv4 address and `LAB_ORIGIN` to the exact address you will open in your browser. Include `http://` or `https://` and omit the trailing slash. Read the [Anyone terms](https://anyone.io/terms). If you accept them, add `ANYONE_TERMS_FLAG=--agree-to-terms`. Keep the generated token in `.env`.

```sh
docker compose config --quiet
docker compose pull caddy anyone
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 anyone
```

The first build downloads Node.js and Python dependencies. The Anyone client then needs outbound TCP connections to Anyone directory authorities and relays. The setup also requires DNS and HTTPS access to package repositories, container registries, and the test service. Compose binds only Caddy's ports 80 and 443 to the LXC address. LAN HTTP uses port 80. Port 443 is reserved for HTTPS. Keep the gateway and SOCKS port 9150 internal.

The Anyone image is pinned by digest in `compose.yaml`. To change the client version, set `ANYONE_IMAGE` in `.env` to a reviewed image digest.

## 4. Run a live test

Wait for the Anyone logs to show that bootstrap has completed. Run the following command inside the LXC with your `LAB_ORIGIN` as the argument.

```sh
bash deploy/smoke-test.sh http://192.168.178.50
```

The script loads the website, checks the API status, and sends a real request through the gateway and SOCKS proxy. On success, it prints the IP reported by the test endpoint, the timings, and the `anyone-rust-socks5h` transport. The status endpoint confirms configuration. The test request checks whether the network path works.

Open the same URL in your browser. Select **Anyone comparison** and then **Test both paths**. Both result cards should display a measured IP address. The direct test runs from the device with your browser. The Anyone test runs from the LXC through the Anyone client. The clipboard button requires HTTPS. The JSON download also works over LAN HTTP.

## Optional HTTPS with your own domain

Create a DNS A record for your domain and forward external TCP ports 80 and 443 to the LXC's IPv4 address. For this IPv4 setup, omit any AAAA record unless Caddy is also reachable at the advertised IPv6 address. Keep `LAB_BIND_IP` set to the LXC's IP. Set `LAB_ORIGIN=https://lab.your-domain.example` and apply the change with `docker compose up -d`. Caddy obtains and renews the TLS certificate. For a public address you want to use privately, restrict access with your firewall or [Caddy's HTTP Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth). The gateway handles up to three simultaneous tests.

## Operations and troubleshooting

| Symptom | What to check |
| --- | --- |
| Docker reports a mount or permission error | Run `pct config <CTID>` on the Proxmox host. Confirm the LXC is unprivileged and has `nesting=1,keyctl=1`. For `ip_unprivileged_port_start … permission denied` on Proxmox VE 9, check the host's `lxc-pve` package. The [fix](https://github.com/opencontainers/runc/issues/4968) is included from `6.0.5-2` onward. Restart the container after updating the host. |
| The website does not respond | Run `docker compose ps` and `docker compose logs caddy web`. Check the LAN IP, bind address, and firewall rules for TCP 80 or 443. |
| The Anyone test returns HTTP 403 | Check the browser URL against `LAB_ORIGIN`. The scheme and host must match exactly. |
| The Anyone test returns HTTP 502 | Run `docker compose logs --tail=80 anyone gateway`. Check bootstrap, outbound TCP connectivity, and whether the Anyone network can reach httpbingo.org. |
| Services do not start after a container reboot | Run `systemctl status docker` and `docker compose ps -a`. Check the container's startup setting on the Proxmox host. |

To update the installation, run the following inside the LXC.

```sh
cd /opt/privacylab
git pull --ff-only
docker compose config --quiet
docker compose up -d --build
```

The `.env` file contains the gateway credential. The Compose volumes store Anyone client state and Caddy's TLS data. Back them up with the LXC. Running `docker compose down` preserves the volumes.

The direct test connects the visitor's browser to `httpbingo.org`, which sees the visitor's public source IP and the test ID. The lab holds results in the current browser session. Visitors can export them as a JSON report. Use the live test above to verify connectivity to the Anyone network.
