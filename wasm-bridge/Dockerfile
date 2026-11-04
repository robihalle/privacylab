FROM debian:13-slim AS snapshot
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 10001 -g 10001 -m 0755 /state
COPY --chmod=0755 artifacts/tor-js-gateway /usr/local/bin/
COPY snapshot.json /etc/privacylab-snapshot.json
ENV HOME=/state
USER 10001:10001
ENTRYPOINT ["tor-js-gateway", "--config", "/etc/privacylab-snapshot.json", "run", "--no-mirror"]

FROM python:3.12-slim AS bridge
RUN pip install --no-cache-dir aiohttp==3.14.5
WORKDIR /lab
COPY server.py .
COPY artifacts/client.js artifacts/tor_js_bg.wasm artifacts/tor_js_bg.wasm.gz ./artifacts/
ENV PYTHONDONTWRITEBYTECODE=1
USER 10002:10002
ENTRYPOINT ["python", "server.py"]
