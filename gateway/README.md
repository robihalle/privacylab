# Anyone Privacy Lab Gateway

Das Gateway ist der interne Python-Adapter des [gemeinsamen LXC-Stacks](../docs/proxmox-lxc.md). Die Website ruft den Adapter über `http://gateway:8080` auf. Der Adapter verwendet den nativen Client unter `socks5h://anyone:9150`. Beide Dienste haben keine veröffentlichten Ports.

- `POST /v1/test` erwartet einen Bearer-Token und eine Testkennung. Das Ziel ist fest auf `https://httpbingo.org/anything/<test-id>` gesetzt.
- Das Gateway verwendet Proxy-DNS, ignoriert Proxy-Umgebungsvariablen, folgt keinen Weiterleitungen und lehnt abweichende Testkennungen sowie ungültige IP-Antworten ab.
- Das interne Docker-Netz verhindert direkte externe Verbindungen des Gateways. Der Anyone-Client besitzt einen separaten ausgehenden Netzwerkanschluss.
- Pro Prozess laufen höchstens drei Messungen gleichzeitig. Die App führt kein Zugriffsprotokoll und speichert keine Messergebnisse auf dem Server.
- Die Laufzeit der Gateway-Messung umfasst den Aufruf über SOCKS bis zum Testziel. Der Webserver misst zusätzlich seine eigene Roundtrip-Zeit zum Gateway.

Die Python-Tests prüfen das Verhalten mit simulierten Netzwerkantworten. Der [Live-Test](../docs/proxmox-lxc.md#4-live-test) prüft den gesamten installierten Pfad.
