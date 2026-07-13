#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R pwuser:pwuser /app/data
  if [ "${TURNSTILE_SOLVER:-browser}" = "browser" ] && [ "${TURNSTILE_BROWSER_SMOKE_ON_START:-true}" != "false" ]; then
    runuser -u pwuser -- node /app/server/browser-smoke.js
  fi
  exec runuser -u pwuser -- "$@"
fi

exec "$@"
