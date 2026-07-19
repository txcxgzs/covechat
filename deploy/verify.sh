#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PUBLIC_URL=""

while (($#)); do
  case "$1" in
    --public-url) [[ $# -ge 2 ]] || exit 2; PUBLIC_URL="${2%/}"; shift 2 ;;
    -h|--help) echo "Usage: ./deploy/verify.sh [--public-url https://chat.example.com]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f .env ]] || { echo "[FAIL] .env 不存在 / .env is missing" >&2; exit 1; }
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1 || {
    echo "[FAIL] 当前用户无权访问 Docker" >&2
    exit 1
  }
  DOCKER=(sudo docker)
fi
COMPOSE=("${DOCKER[@]}" compose --env-file .env -f compose.deploy.yml)
EXPECTED=(web api postgres redis minio)
FAILURES=0

pass() { printf '[PASS] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

echo "等待服务健康 / Waiting for services..."
DEADLINE=$((SECONDS + 180))
while ((SECONDS < DEADLINE)); do
  READY=1
  for service in "${EXPECTED[@]}"; do
    ID="$("${COMPOSE[@]}" ps -q "$service")"
    [[ -n "$ID" ]] || { READY=0; continue; }
    STATUS="$("${DOCKER[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$ID" 2>/dev/null || true)"
    [[ "$STATUS" == "healthy" || "$STATUS" == "running" ]] || READY=0
  done
  ((READY == 1)) && break
  sleep 3
done

for service in "${EXPECTED[@]}"; do
  ID="$("${COMPOSE[@]}" ps -q "$service")"
  if [[ -z "$ID" ]]; then
    fail "服务缺失 / Missing service: $service"
    continue
  fi
  STATUS="$("${DOCKER[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$ID" 2>/dev/null || true)"
  if [[ "$STATUS" == "healthy" || "$STATUS" == "running" ]]; then
    pass "$service: $STATUS"
  else
    fail "$service: $STATUS"
  fi
done

"${COMPOSE[@]}" exec -T postgres pg_isready -U covechat -d covechat >/dev/null 2>&1 \
  && pass "PostgreSQL ready" || fail "PostgreSQL unavailable"
[[ "$("${COMPOSE[@]}" exec -T redis redis-cli PING 2>/dev/null | tr -d '\r')" == "PONG" ]] \
  && pass "Redis PING" || fail "Redis unavailable"
"${COMPOSE[@]}" exec -T web wget -qO- http://localhost/healthz >/dev/null 2>&1 \
  && pass "Web /healthz" || fail "Web /healthz"
"${COMPOSE[@]}" exec -T api /usr/local/bin/covechat-api --healthcheck >/dev/null 2>&1 \
  && pass "API /health" || fail "API /health"
"${COMPOSE[@]}" exec -T web wget -qO- http://minio:9000/minio/health/live >/dev/null 2>&1 \
  && pass "MinIO health" || fail "MinIO health"

if [[ -n "$PUBLIC_URL" ]]; then
  command -v curl >/dev/null 2>&1 || { fail "curl is required for public checks"; }
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_URL/healthz" || true)" == "200" ]] \
    && pass "Public /healthz" || fail "Public /healthz"
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/health" || true)" == "200" ]] \
    && pass "Public /api/health" || fail "Public /api/health"
fi

if ((FAILURES > 0)); then
  echo "验证失败 / Verification failed: $FAILURES" >&2
  exit 1
fi
echo "部署验证通过 / Deployment verification passed."
