#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
compose=(docker compose -f docker-compose.yml -f docker-compose.server.yml)
"${compose[@]}" exec -T frosted-console node server/backup.js create
