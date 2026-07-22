#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST_ADDRESS="127.0.0.1"
PORT="8088"
PORT_SET=0
PORT_CONFIGURED=0
PUBLIC_ORIGIN=""
SKIP_VERIFY=0

usage() {
  cat <<'EOF'
用法 / Usage:
  ./deploy.sh [--domain chat.example.com] [--host 127.0.0.1] [--port 8088] [--skip-verify]

首次部署或重新构建 CoveChat。默认仅监听 127.0.0.1:8088，供 Nginx、Caddy
或宝塔反向代理。--domain 会自动写入 https:// 域名的 Origin 允许列表。
EOF
}

while (($#)); do
  case "$1" in
    --domain) [[ $# -ge 2 ]] || exit 2; PUBLIC_ORIGIN="$2"; shift 2 ;;
    --host) [[ $# -ge 2 ]] || exit 2; HOST_ADDRESS="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || exit 2; PORT="$2"; PORT_SET=1; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数 / Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ((PORT_SET == 0)) && [[ -f .env ]]; then
  EXISTING_PORT="$(sed -n 's/^COVECHAT_HTTP_PORT=//p' .env | tail -n 1 | tr -d '\r')"
  if [[ "$EXISTING_PORT" =~ ^[0-9]+$ ]] && ((EXISTING_PORT >= 1 && EXISTING_PORT <= 65535)); then
    PORT="$EXISTING_PORT"
    PORT_CONFIGURED=1
    echo "[OK] 复用现有反向代理上游端口 ${PORT} / Reusing configured upstream port ${PORT}."
  fi
fi

if ((PORT_SET == 0 && PORT_CONFIGURED == 0)) && [[ -t 0 ]]; then
  read -r -p "反向代理上游端口 / Reverse-proxy upstream port [8088]: " INPUT_PORT
  PORT="${INPUT_PORT:-8088}"
  [[ -n "$INPUT_PORT" ]] && PORT_SET=1
fi

[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || {
  echo "端口必须是 1-65535 / Port must be between 1 and 65535." >&2
  exit 2
}
[[ "$HOST_ADDRESS" =~ ^[0-9a-fA-F:.]+$ ]] || {
  echo "--host 必须是 IP 地址 / --host must be an IP address." >&2
  exit 2
}
if [[ -n "$PUBLIC_ORIGIN" ]]; then
  if [[ "$PUBLIC_ORIGIN" != http://* && "$PUBLIC_ORIGIN" != https://* ]]; then
    PUBLIC_ORIGIN="https://${PUBLIC_ORIGIN}"
  fi
  PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"
fi

command -v docker >/dev/null 2>&1 || {
  echo "未找到 Docker。请先运行 ./install.sh --install-docker，或安装 Docker Engine。" >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  echo "未找到 Docker Compose 插件。" >&2
  exit 1
}
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1 || {
    echo "当前用户无权访问 Docker，请配置 docker 组或使用 sudo。" >&2
    exit 1
  }
  DOCKER=(sudo docker)
fi

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n'
  else
    head -c 36 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
  fi
}

if [[ ! -f .env ]]; then
  umask 077
  cat > .env <<EOF
# CoveChat production deployment configuration. Keep this file private.
COVECHAT_HTTP_HOST=${HOST_ADDRESS}
COVECHAT_HTTP_PORT=${PORT}
POSTGRES_PASSWORD=$(random_secret)
MINIO_ROOT_USER=covechat
MINIO_ROOT_PASSWORD=$(random_secret)
ALLOWED_ORIGINS=${PUBLIC_ORIGIN}
COVECHAT_SETUP_TOKEN=$(random_secret)
COVECHAT_ADMIN_PATH=/manage-$(random_secret | cut -c1-16)
COVECHAT_ADMIN_TOKEN=$(random_secret)
EOF
  chmod 600 .env
  echo "[OK] 已生成 .env（权限 0600）/ Generated private .env."
else
  echo "[OK] 使用现有 .env；不会覆盖密码。显式传入的端口或域名会更新。"
  if ((PORT_SET == 1)); then
    if grep -q '^COVECHAT_HTTP_PORT=' .env; then
      sed -i.bak "s|^COVECHAT_HTTP_PORT=.*|COVECHAT_HTTP_PORT=${PORT}|" .env
    else
      printf '\nCOVECHAT_HTTP_PORT=%s\n' "$PORT" >> .env
    fi
    rm -f .env.bak
    echo "[OK] 反向代理上游端口已更新为 ${PORT}。"
  fi
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    if grep -q '^ALLOWED_ORIGINS=' .env; then
      sed -i.bak "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=${PUBLIC_ORIGIN}|" .env
    else
      printf '\nALLOWED_ORIGINS=%s\n' "$PUBLIC_ORIGIN" >> .env
    fi
    rm -f .env.bak
  fi
fi

if ! grep -q '^COVECHAT_SETUP_TOKEN=' .env; then
  printf '\nCOVECHAT_SETUP_TOKEN=%s\n' "$(random_secret)" >> .env
  chmod 600 .env
fi
if ! grep -q '^COVECHAT_ADMIN_PATH=' .env; then
  printf '\nCOVECHAT_ADMIN_PATH=/manage-%s\n' "$(random_secret | cut -c1-16)" >> .env
fi
if ! grep -q '^COVECHAT_ADMIN_TOKEN=' .env; then
  printf '\nCOVECHAT_ADMIN_TOKEN=%s\n' "$(random_secret)" >> .env
fi
chmod 600 .env

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${ALLOWED_ORIGINS:-}" ]]; then
  echo "[SETUP] 打开站点后按网页向导配置域名 / Configure the domain in the browser setup wizard."
  echo "[SETUP] 安装令牌 / Setup token: ${COVECHAT_SETUP_TOKEN}"
fi

COMPOSE=("${DOCKER[@]}" compose --env-file .env -f compose.deploy.yml)
echo "[1/3] 拉取基础镜像 / Pulling base images..."
"${COMPOSE[@]}" pull postgres redis minio
echo "[2/3] 构建并启动 / Building and starting..."
echo "[INFO] 首次构建 Rust API 通常需要 5-15 分钟；后续更新会复用 Docker 构建缓存。"
"${COMPOSE[@]}" up -d --build --pull always --remove-orphans
echo "[3/3] 等待健康检查 / Waiting for health checks..."

if ((SKIP_VERIFY == 0)); then
  ./deploy/verify.sh
fi

cat <<EOF

CoveChat 已启动 / CoveChat is running
  本机上游 / Upstream: http://${COVECHAT_HTTP_HOST:-127.0.0.1}:${COVECHAT_HTTP_PORT:-8088}
  状态 / Status: docker compose --env-file .env -f compose.deploy.yml ps
  日志 / Logs:   docker compose --env-file .env -f compose.deploy.yml logs -f
  更新 / Update: ./update.sh
  管理后台 / Admin: ${ALLOWED_ORIGINS:-http://${COVECHAT_HTTP_HOST:-127.0.0.1}:${COVECHAT_HTTP_PORT:-8088}}${COVECHAT_ADMIN_PATH}
  管理令牌 / Admin token: ${COVECHAT_ADMIN_TOKEN}
EOF

if [[ -z "${ALLOWED_ORIGINS:-}" ]]; then
  echo "  网页配置 / Web setup: open your domain and enter token ${COVECHAT_SETUP_TOKEN}"
fi
