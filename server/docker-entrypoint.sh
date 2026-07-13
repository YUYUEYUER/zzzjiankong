#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R pwuser:pwuser /app/data
  if [ -n "${MIHOMO_SHARED_DIR:-}" ]; then
    mkdir -p "$MIHOMO_SHARED_DIR"
    chown -R pwuser:pwuser "$MIHOMO_SHARED_DIR"
  fi
  if [ "${TURNSTILE_SOLVER:-browser}" = "browser" ] && [ "${TURNSTILE_BROWSER_SMOKE_ON_START:-true}" != "false" ]; then
    runuser -u pwuser -- node /app/server/browser-smoke.js
  fi
  exec runuser -u pwuser -- "$@"
fi

exec "$@"
