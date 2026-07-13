#!/bin/sh
set -eu

shared_dir="${MIHOMO_SHARED_DIR:-/shared-proxy}"
secret="${MIHOMO_SECRET:?MIHOMO_SECRET must be set}"
bind_address="${MIHOMO_BIND_ADDRESS:-127.0.0.1}"
controller_bind_address="${MIHOMO_CONTROLLER_BIND_ADDRESS:-127.0.0.1}"
mkdir -p "$shared_dir"

cat > "$shared_dir/bootstrap.yaml" <<EOF
allow-lan: true
bind-address: "$bind_address"
mode: rule
log-level: warning
external-controller: "$controller_bind_address:9090"
secret: "$secret"
rules:
  - MATCH,DIRECT
EOF

if command -v mihomo >/dev/null 2>&1; then
  binary="$(command -v mihomo)"
elif [ -x /mihomo ]; then
  binary=/mihomo
else
  echo "mihomo binary not found" >&2
  exit 1
fi

config_file="$shared_dir/bootstrap.yaml"
runtime_file="$shared_dir/config.yaml"
if [ -s "$runtime_file" ] && "$binary" -t -d "$shared_dir" -f "$runtime_file" >/dev/null 2>&1; then
  config_file="$runtime_file"
fi

exec "$binary" -d "$shared_dir" -f "$config_file"
