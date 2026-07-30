#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: ./restore-linux.sh /app/data/backups/frosted-console-*.json" >&2
  exit 2
fi

compose=(docker compose -f docker-compose.yml -f docker-compose.server.yml)
"${compose[@]}" config --quiet
"${compose[@]}" stop frosted-console
trap '"${compose[@]}" up -d frosted-console >/dev/null' EXIT
"${compose[@]}" run --rm --no-deps --entrypoint node frosted-console server/backup.js restore "$1"
echo "Backup restored; frosted-console is restarting."
