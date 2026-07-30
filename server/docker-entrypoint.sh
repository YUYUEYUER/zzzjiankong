#!/bin/sh
set -eu

start_remote_desktop() {
  if [ "${NOVNC_ENABLED:-false}" != "true" ]; then
    return
  fi

  export DISPLAY="${DISPLAY:-:99}"
  geometry="${NOVNC_GEOMETRY:-1600x900x24}"
  display_number="${DISPLAY#:}"
  display_number="${display_number%%.*}"
  runtime_dir="/tmp/frosted-pwuser-runtime"
  mkdir -p "$runtime_dir"
  chown pwuser:pwuser "$runtime_dir"
  chmod 700 "$runtime_dir"

  runuser -u pwuser -- env HOME=/home/pwuser XDG_RUNTIME_DIR="$runtime_dir" \
    Xvfb "$DISPLAY" -screen 0 "$geometry" -ac +extension RANDR >/tmp/frosted-xvfb.log 2>&1 &

  attempts=0
  while [ ! -S "/tmp/.X11-unix/X${display_number}" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      echo "[desktop] Xvfb failed to become ready" >&2
      exit 1
    fi
    sleep 0.1
  done

  runuser -u pwuser -- env HOME=/home/pwuser DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$runtime_dir" \
    openbox >/tmp/frosted-openbox.log 2>&1 &
  runuser -u pwuser -- env HOME=/home/pwuser DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$runtime_dir" \
    x11vnc -display "$DISPLAY" -forever -shared -localhost -nopw -rfbport 5900 -noxdamage \
    >/tmp/frosted-x11vnc.log 2>&1 &
  runuser -u pwuser -- env HOME=/home/pwuser XDG_RUNTIME_DIR="$runtime_dir" \
    websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 \
    >/tmp/frosted-websockify.log 2>&1 &
  echo "[desktop] headed Chromium workspace ready on display $DISPLAY"
}

if [ "$(id -u)" = "0" ]; then
  chown -R pwuser:pwuser /app/data
  if [ -n "${MIHOMO_SHARED_DIR:-}" ]; then
    mkdir -p "$MIHOMO_SHARED_DIR"
    chown -R pwuser:pwuser "$MIHOMO_SHARED_DIR"
  fi
  start_remote_desktop
  if [ "${TURNSTILE_SOLVER:-browser}" = "browser" ] && [ "${TURNSTILE_BROWSER_SMOKE_ON_START:-true}" != "false" ]; then
    runuser -u pwuser -- env HOME=/home/pwuser DISPLAY="${DISPLAY:-:99}" node /app/server/browser-smoke.js
  fi
  exec runuser -u pwuser -- env HOME=/home/pwuser DISPLAY="${DISPLAY:-:99}" "$@"
fi

exec "$@"
