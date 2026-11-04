# Anyone Privacy Lab auf Proxmox installieren

Alle Dienste laufen gemeinsam in einem eigenen Debian-LXC. Der Stack startet Caddy, Next.js, das Python-Gateway und den nativen Anyone-Rust-Client. Für die erste Inbetriebnahme ist HTTP im eigenen LAN vorgesehen. Eine Domain kann anschließend HTTPS erhalten.

## 1. LXC auf dem Proxmox-Host anlegen

In der Proxmox-Oberfläche ein Debian-13-Standardtemplate für **amd64** herunterladen und **CT erstellen** wählen. Das vorgegebene Anyone-Rust-Image wurde für Linux amd64 veröffentlicht.

| Einstellung | Startwert |
| --- | --- |
| Hostname | `privacy-lab` |
| Container | Unprivilegiert |
| CPU | 2 Kerne |
| RAM und Swap | 2 GiB RAM und 1 GiB Swap |
| Root-Disk | 12 GiB |
| Netzwerk | Eigene feste LAN-IPv4 oder DHCP-Reservierung, passendes Gateway und DNS |
| Features | `nesting=1,keyctl=1` |
| Start beim Booten | Aktiviert |

Beim neuen, noch gestoppten Container die Features und den Autostart setzen. `150` durch die tatsächlich gewählte CT-ID ersetzen. Diese Befehle laufen auf dem **Proxmox-Host**.

```sh
CTID=150
pct set "$CTID" --features nesting=1,keyctl=1 --onboot 1
pct start "$CTID"
pct enter "$CTID"
```

## 2. Docker im LXC installieren

Ab hier alle Befehle als `root` **im LXC** ausführen. Die Pakete kommen aus dem offiziellen [Docker-APT-Repository für Debian](https://docs.docker.com/engine/install/debian/).

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

## 3. Privacy Lab starten

```sh
git clone https://github.com/robihalle/privacylab.git /opt/privacylab
cd /opt/privacylab
install -m 0600 deploy/lxc.env.example .env
printf '\nGATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
nano .env
```

In `.env` beide Beispielwerte mit der eigenen LXC-IP belegen. `LAB_ORIGIN` ist die exakte Adresse, die du später im Browser aufrufst, inklusive `http://` oder `https://` und ohne abschließenden Schrägstrich. Lies die [Anyone-Nutzungsbedingungen](https://anyone.io/terms). Falls du sie akzeptierst, ergänze `ANYONE_TERMS_FLAG=--agree-to-terms`. Der zufällige Token bleibt in `.env`.

```sh
docker compose config --quiet
docker compose pull caddy anyone
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 anyone
```

Der erste Build lädt Node- und Python-Abhängigkeiten. Der Client benötigt danach ausgehende TCP-Verbindungen zu Anyone-Authorities und Relays. Für das gesamte Setup werden außerdem DNS und HTTPS zu den Paketquellen, Container-Registries und dem Testdienst benötigt. Eingehend bindet Compose nur Caddys Ports 80 und 443 an die LXC-IP. Im HTTP-LAN-Betrieb wird Port 80 verwendet. Port 443 ist für HTTPS reserviert. Die interne Gateway-Schnittstelle und der SOCKS-Port 9150 brauchen keine Freigabe.

Das Anyone-Image ist in `compose.yaml` per Digest fixiert. Für einen gezielten Clientwechsel kann `ANYONE_IMAGE` in `.env` auf einen geprüften Digest gesetzt werden.

## 4. Live-Test

Warte auf den abgeschlossenen Bootstrap in den Anyone-Logs. Dann im LXC ausführen, mit der Adresse aus `.env` als Argument.

```sh
bash deploy/smoke-test.sh http://192.168.178.50
```

Der Test lädt die Website, prüft den API-Status und fordert eine echte Messung über Gateway und SOCKS an. Bei Erfolg erscheinen die vom Testziel gemeldete IP, die Messzeiten und der Transport `anyone-rust-socks5h`. Der Statusendpunkt allein bestätigt nur die Konfiguration.

Öffne dieselbe URL im Browser. Wähle **Anyone-Vergleich** und **Beide Wege testen**. Beide Ergebniskarten sollen eine gemessene IP anzeigen. Die direkte Messung erfolgt vom Gerät mit dem Browser, die zweite vom LXC über den Anyone-Client. Für die Browser-Zwischenablage ist HTTPS erforderlich. Der JSON-Download funktioniert auch über LAN-HTTP.

## Optional mit eigener Domain und HTTPS

Setze einen DNS-A-Record für deine Domain und leite extern TCP 80 und 443 an die LXC-IP weiter. Für den hier beschriebenen IPv4-Aufbau keinen AAAA-Record auf eine Adresse zeigen lassen, unter der Caddy nicht erreichbar ist. `LAB_BIND_IP` bleibt die LXC-IP. Setze `LAB_ORIGIN=https://lab.deine-domain.de` und wende die Änderung mit `docker compose up -d` an. Caddy bezieht und erneuert das Zertifikat. Falls du ein öffentlich erreichbares Lab nur selbst nutzen möchtest, begrenze den Zugriff über deine Firewall oder [Caddys HTTP Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth). Der Vergleich kann bis zu drei Gateway-Messungen parallel ausführen.

## Betrieb und Fehlersuche

| Symptom | Prüfung |
| --- | --- |
| Docker meldet einen Mount- oder Berechtigungsfehler | Auf dem Proxmox-Host `pct config <CTID>` prüfen. Der LXC soll unprivilegiert sein und `nesting=1,keyctl=1` gesetzt haben. Bei `ip_unprivileged_port_start … permission denied` auf Proxmox VE 9 das Hostpaket `lxc-pve` prüfen. Der [Fix](https://github.com/opencontainers/runc/issues/4968) ist ab `6.0.5-2` enthalten. Nach dem Host-Update den CT neu starten. |
| Website antwortet nicht | `docker compose ps` und `docker compose logs caddy web` prüfen. LAN-IP, Bind-Adresse und die Freigabe für TCP 80 beziehungsweise 443 kontrollieren. |
| Anyone-Test antwortet mit HTTP 403 | Browseradresse und `LAB_ORIGIN` abgleichen. Protokoll und Host müssen exakt übereinstimmen. |
| Anyone-Test antwortet mit HTTP 502 | `docker compose logs --tail=80 anyone gateway` prüfen. Bootstrap, ausgehende TCP-Verbindungen und die Erreichbarkeit von httpbingo.org über das Anyone-Netz prüfen. |
| Dienste starten nach CT-Neustart nicht | `systemctl status docker` und `docker compose ps -a` prüfen. Der CT-Autostart wird auf dem Proxmox-Host gesetzt. |

Nach einem Repository-Update im LXC:

```sh
cd /opt/privacylab
git pull --ff-only
docker compose config --quiet
docker compose up -d --build
```

`.env` enthält die Zugangsdaten. Die Compose-Volumes halten den Anyone-Zustand und die TLS-Daten von Caddy. Sichere sie mit dem LXC. Ein normales `docker compose down` erhält die Volumes.

Der Besucher verbindet sich für den Direkt-Test mit `httpbingo.org`. Der Testdienst sieht dabei seine öffentliche Quell-IP und die Testkennung. Das Lab speichert Messwerte nur in der laufenden Browsersitzung, bis der Nutzer sie exportiert. Die Anzeige des Gateway-Status ist kein Nachweis für die Erreichbarkeit des Anyone-Netzes. Dafür gibt es den Live-Test oben.
