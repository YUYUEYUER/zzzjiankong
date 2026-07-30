#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
compose=(docker compose -f docker-compose.yml -f docker-compose.server.yml)
"${compose[@]}" config --quiet
"${compose[@]}" stop frosted-console
trap '"${compose[@]}" up -d frosted-console >/dev/null' EXIT
"${compose[@]}" run --rm --no-deps --entrypoint node frosted-console server/rotate-master-key.js
echo "MASTER_KEY rotation complete; keep the previous key until restore verification succeeds."
