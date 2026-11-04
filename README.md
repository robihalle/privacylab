# Anyone Privacy Lab

Eigenständige Tech-Demo für das Anyone-Netzwerk. Sie vergleicht, welche Quell-IP ein HTTPS-Ziel bei einer direkten Browseranfrage und bei einer Anfrage über den nativen Anyone-Rust-Client sieht.

## Installation auf Proxmox

Die [Schritt-für-Schritt-Anleitung](docs/proxmox-lxc.md) führt vom leeren Debian-13-LXC auf amd64 bis zum Live-Test. Ein Docker-Compose-Stack startet Website, Caddy, Gateway und Anyone-Client im selben unprivilegierten LXC. Caddy ist der einzige Dienst mit veröffentlichten Ports. Gateway und SOCKS bleiben im internen Docker-Netz.

Der Direkt-Test läuft vom Browser zu `httpbingo.org`. Für den Anyone-Test nimmt die Website nur eine Testkennung entgegen und leitet sie an das interne Gateway. Dieses ruft dasselbe feste HTTPS-Ziel über SOCKS mit Proxy-DNS auf. Die Ergebnisse zeigen, was das Testziel meldet. Die Grafik veranschaulicht den Verbindungsweg und verwendet keine Live-Topologie. Website und Gateway laufen serverseitig, der Rust-Client läuft nativ im LXC.

## Entwicklung

Node.js 24 und pnpm 11.25.0 verwenden.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Die Website ist dann unter http://localhost:3000 erreichbar. Der Anyone-Vergleich benötigt den Compose-Stack.

```sh
pnpm build
node --test tests/privacy-api.test.mjs
python3 -m venv /tmp/privacylab-venv
/tmp/privacylab-venv/bin/pip install -r gateway/requirements.txt
/tmp/privacylab-venv/bin/python -m unittest discover -s gateway -p test_gateway.py
```

Die [Gateway-Dokumentation](gateway/README.md) beschreibt den internen Adapter. Das Projekt ist eine unabhängige Community-Demo. Upstream-Client ist [anyone-protocol/anyone-rust](https://github.com/anyone-protocol/anyone-rust). Drittanbieter-Code behält seine jeweiligen Lizenzbedingungen.
