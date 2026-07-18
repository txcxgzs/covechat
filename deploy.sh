#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST_ADDRESS="127.0.0.1"
PORT="8088"

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [--host 127.0.0.1] [--port 8088]

Builds and starts CoveChat with Docker Compose. By default only the local
loopback address is exposed, ready for an Nginx or Caddy reverse proxy.
EOF
}

while (($#)); do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || { echo "Missing value for --host" >&2; exit 2; }
      HOST_ADDRESS="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "Missing value for --port" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || {
  echo "Port must be an integer between 1 and 65535." >&2
  exit 2
}
[[ "$HOST_ADDRESS" =~ ^[0-9a-fA-F:.]+$ ]] || {
  echo "Host must be an IP address, not a hostname." >&2
  exit 2
}

command -v docker >/dev/null 2>&1 || {
  echo "Docker was not found. Install Docker Engine with the Compose plugin." >&2
  exit 1
}
docker compose version >/dev/null

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
  else
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
  fi
}

if [[ ! -f .env ]]; then
  umask 077
  cat >.env <<EOF
# CoveChat 部署配置（自动生成，权限 0600）
# 反向代理上游监听地址（默认只监听本机回环，由宝塔/Nginx/Caddy 反代到公网）
COVECHAT_HTTP_HOST=$HOST_ADDRESS
COVECHAT_HTTP_PORT=$PORT

# 基础设施随机强密码（请勿修改，除非同步轮换对应服务凭据）
POSTGRES_PASSWORD=$(random_secret)
MINIO_ROOT_USER=covechat
MINIO_ROOT_PASSWORD=$(random_secret)

# 第 6 轮新增：CSRF 纵深防御的 Origin 允许列表（逗号分隔，不含尾斜杠）。
# 留空 = 开发模式放行所有 Origin（不安全，仅用于本地测试）。
# 生产部署必须设置为实际公网域名，例如：
#   ALLOWED_ORIGINS=https://chat.example.com
#   ALLOWED_ORIGINS=https://chat.example.com,https://chat-backup.example.com
ALLOWED_ORIGINS=
EOF
  echo "Created .env with random infrastructure passwords."
  echo ""
  echo "⚠️  重要：编辑 .env 设置 ALLOWED_ORIGINS 为你的公网域名，"
  echo "    否则 Origin 校验处于开发模式放行所有请求（不安全）。"
  echo "    示例：ALLOWED_ORIGINS=https://chat.example.com"
else
  echo "Using existing .env. Command-line host and port are ignored."
fi

docker compose --env-file .env -f compose.deploy.yml up -d --build

TARGET="http://${HOST_ADDRESS}:${PORT}"
cat <<EOF

CoveChat is starting at: $TARGET
Reverse proxy upstream: $TARGET
Status: docker compose --env-file .env -f compose.deploy.yml ps
Logs:   docker compose --env-file .env -f compose.deploy.yml logs -f
Stop:   docker compose --env-file .env -f compose.deploy.yml down

部署后请跑验证脚本（推荐传入公网域名）：
  chmod +x deploy/verify.sh
  ./deploy/verify.sh --public-url https://chat.example.com

⚠️  如果你还没有编辑 .env 设置 ALLOWED_ORIGINS，请先编辑再重建 API 容器：
  vi .env  # 设置 ALLOWED_ORIGINS=https://你的域名
  docker compose --env-file .env -f compose.deploy.yml up -d --force-recreate api
EOF
