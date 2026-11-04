#!/usr/bin/env bash
set -euo pipefail

origin=${1:?Usage: bash deploy/smoke-test.sh http://LXC-IP}
origin=${origin%/}
nonce=$(cat /proc/sys/kernel/random/uuid)

curl -fsS --max-time 10 "$origin/" -o /dev/null
curl -fsS --max-time 10 "$origin/api/lab/status" \
  | jq -e '.configured == true and .transport == "native-rust-gateway"' >/dev/null

curl -fsS --max-time 55 "$origin/api/lab/test" \
  -H "Origin: $origin" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg nonce "$nonce" '{nonce:$nonce}')" \
  | jq -e --arg nonce "$nonce" '
      if .nonce == $nonce and .transport == "anyone-rust-socks5h" and
        .target == "httpbingo.org" and (.ip | type == "string" and length > 0)
      then {ip, elapsedMs, gatewayRoundtripMs, target, transport}
      else error("Anyone response did not match the test")
      end'
