#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

domain="${1:-${DOMAIN:-}}"
deploy_mode="${2:---build}"
if [[ -z "$domain" && -t 0 ]]; then
  read -r -p "请输入面板域名（例如 panel.example.com）: " domain
fi
if [[ -z "$domain" ]]; then
  echo "用法: ./deploy-linux.sh panel.example.com [--build|--image]" >&2
  exit 1
fi
if [[ "$domain" == *"://"* || "$domain" == */* || ! "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "域名格式无效，请只填写主机名，例如 panel.example.com" >&2
  exit 1
fi
domain="${domain,,}"

if [[ "$deploy_mode" != "--build" && "$deploy_mode" != "--image" ]]; then
  echo "部署模式无效，请使用 --build 或 --image" >&2
  exit 1
fi

command -v docker >/dev/null || { echo "请先安装 Docker Engine 与 Compose 插件" >&2; exit 1; }
docker compose version >/dev/null
command -v openssl >/dev/null || { echo "请先安装 openssl" >&2; exit 1; }

if [[ ! -f .env ]]; then
  umask 077
  cp .env.example .env
fi

upsert_env() {
  local key="$1" value="$2" temp
  temp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' .env >"$temp"
  mv "$temp" .env
  chmod 600 .env
}

env_value() {
  awk -F= -v key="$1" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' .env
}

ensure_secret() {
  local key="$1" current
  current="$(env_value "$key")"
  if [[ -z "$current" || "$current" == replace-with-* ]]; then
    upsert_env "$key" "$(openssl rand -hex 32)"
  fi
}

ensure_secret MASTER_KEY
ensure_secret SESSION_SECRET
ensure_secret MIHOMO_SECRET
ensure_secret BOOTSTRAP_TOKEN
upsert_env DOMAIN "$domain"
upsert_env APP_ORIGIN "https://$domain"
upsert_env AUTH_DISABLED "false"
upsert_env TRUST_PROXY "true"
upsert_env TURNSTILE_HEADLESS "false"
upsert_env NOVNC_ENABLED "true"
upsert_env BROWSER_WORKSPACE_URL "/browser/vnc.html?autoconnect=true&resize=remote&reconnect=true&path=browser%2Fwebsockify"
upsert_env SEED_DEMO "false"

compose=(docker compose -f docker-compose.yml -f docker-compose.server.yml)
"${compose[@]}" config --quiet
if [[ "$deploy_mode" == "--image" ]]; then
  "${compose[@]}" pull frosted-console
  "${compose[@]}" up -d --no-build --force-recreate --remove-orphans
else
  "${compose[@]}" up -d --build --force-recreate --remove-orphans
fi

app_container="$("${compose[@]}" ps -q frosted-console)"
if [[ -z "$app_container" ]]; then
  echo "霜镜容器未创建，请检查 Docker 日志。" >&2
  exit 1
fi

echo "正在等待霜镜通过健康检查..."
app_health=""
for ((attempt = 1; attempt <= 180; attempt += 1)); do
  app_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_container" 2>/dev/null || true)"
  if [[ "$app_health" == "healthy" ]]; then
    break
  fi
  if [[ "$app_health" == "unhealthy" || "$app_health" == "exited" || "$app_health" == "dead" ]]; then
    "${compose[@]}" logs --tail=120 frosted-console >&2
    echo "霜镜启动失败，当前状态: $app_health" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$app_health" != "healthy" ]]; then
  "${compose[@]}" logs --tail=120 frosted-console >&2
  echo "等待健康检查超时，请根据上方日志排查。" >&2
  exit 1
fi

"${compose[@]}" ps

echo
echo "霜镜已启动: https://$domain"
echo "首次初始化引导令牌: $(env_value BOOTSTRAP_TOKEN)"
echo "配置文件: $PWD/.env"
echo "请确认域名 A/AAAA 记录指向本机，并在防火墙放行 TCP 80/443 与 UDP 443。"
