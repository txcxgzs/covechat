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
COVECHAT_HTTP_HOST=$HOST_ADDRESS
COVECHAT_HTTP_PORT=$PORT
POSTGRES_PASSWORD=$(random_secret)
MINIO_ROOT_USER=covechat
MINIO_ROOT_PASSWORD=$(random_secret)
EOF
  echo "Created .env with random infrastructure passwords."
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
EOF
