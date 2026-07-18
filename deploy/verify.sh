#!/usr/bin/env bash
# CoveChat 部署后验证脚本（在 Linux 服务器上执行）
#
# 用途：跑完 ./deploy.sh 之后，用本脚本一键验证：
#   1. 所有 docker compose 服务状态健康
#   2. PostgreSQL 10 张迁移表全部建成
#   3. Redis 连通
#   4. MinIO 健康端点可访问
#   5. API /health 返回 200
#   6. Web 入口 /healthz 返回 200
#   7. 反向代理（如已配置）能从公网域名访问到 /healthz
#   8. Origin 校验生效（POST 非法 Origin 应返回 403）
#
# 用法：
#   chmod +x deploy/verify.sh
#   ./deploy/verify.sh                         # 只验证容器内部
#   ./deploy/verify.sh --public-url https://chat.example.com  # 同时验证反代和 Origin
#
# 退出码：0=全部通过；1=至少一项失败。

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PUBLIC_URL=""
ALLOWED_ORIGIN=""

usage() {
  cat <<'EOF'
Usage: ./deploy/verify.sh [--public-url https://chat.example.com]

Options:
  --public-url URL    公网访问地址（含 https://），用于验证反向代理和 Origin 校验。
                      不传则跳过反代与 Origin 校验项。
  -h, --help          显示本帮助。
EOF
}

while (($#)); do
  case "$1" in
    --public-url)
      [[ $# -ge 2 ]] || { echo "Missing value for --public-url" >&2; exit 2; }
      PUBLIC_URL="$2"
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

# 从 PUBLIC_URL 派生 ALLOWED_ORIGIN（用于 Origin 校验项）
if [[ -n "$PUBLIC_URL" ]]; then
  ALLOWED_ORIGIN="${PUBLIC_URL%/}"  # 去掉末尾斜杠
fi

# 计数器
PASS=0
FAIL=0
FAILED_ITEMS=()

# 颜色输出（如非 tty 则降级为纯文本）
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  YELLOW=$'\033[33m'
  RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; RESET=""
fi

ok() {
  echo "${GREEN}[PASS]${RESET} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "${RED}[FAIL]${RESET} $1"
  FAIL=$((FAIL + 1))
  FAILED_ITEMS+=("$1")
}

skip() {
  echo "${YELLOW}[SKIP]${RESET} $1"
}

info() {
  echo "       $1"
}

# 必须存在 .env 文件
if [[ ! -f .env ]]; then
  fail ".env 不存在，请先在项目根目录运行 ./deploy.sh"
  exit 1
fi

# 公共 docker compose 命令前缀
DC="docker compose --env-file .env -f compose.deploy.yml"

echo "==================== CoveChat 部署验证 ===================="
echo ""

# ---------- 1. docker compose ps 状态 ----------
echo ">>> 1/8 检查 docker compose 服务状态"
SERVICES_OUTPUT="$($DC ps --format '{{.Service}}\t{{.Status}}' 2>/dev/null || true)"
if [[ -z "$SERVICES_OUTPUT" ]]; then
  fail "docker compose ps 无输出，可能服务未启动"
else
  # 期望 5 个服务：web / api / postgres / redis / minio
  EXPECTED_SERVICES=(web api postgres redis minio)
  for svc in "${EXPECTED_SERVICES[@]}"; do
    line="$(echo "$SERVICES_OUTPUT" | grep -E "^${svc}\t" || true)"
    if [[ -z "$line" ]]; then
      fail "服务 $svc 未在 docker compose ps 中出现"
    elif echo "$line" | grep -qiE "healthy|running"; then
      ok "服务 $svc 状态: $(echo "$line" | cut -f2)"
    else
      fail "服务 $svc 状态异常: $(echo "$line" | cut -f2)"
    fi
  done
fi
echo ""

# ---------- 2. PostgreSQL 迁移表 ----------
echo ">>> 2/8 检查 PostgreSQL 迁移表"
EXPECTED_TABLES=(accounts devices envelopes delivery_counters idempotency_keys backups attachments attachment_chunks abuse_reports user_blocks)
PG_RESULT="$(docker compose --env-file .env -f compose.deploy.yml exec -T postgres \
  psql -U covechat -d covechat -t -A -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;" 2>/dev/null || true)"
if [[ -z "$PG_RESULT" ]]; then
  fail "无法从 PostgreSQL 查询表清单（可能 postgres 容器未就绪或凭据错误）"
else
  for tbl in "${EXPECTED_TABLES[@]}"; do
    if echo "$PG_RESULT" | grep -qx "$tbl"; then
      ok "迁移表 $tbl 存在"
    else
      fail "迁移表 $tbl 缺失"
    fi
  done
fi
echo ""

# ---------- 3. Redis 连通 ----------
echo ">>> 3/8 检查 Redis 连通"
REDIS_PING="$(docker compose --env-file .env -f compose.deploy.yml exec -T redis redis-cli PING 2>/dev/null || true)"
if [[ "$REDIS_PING" == "PONG" ]]; then
  ok "Redis PING → PONG"
else
  fail "Redis PING 失败（实际返回: '$REDIS_PING'）"
fi
echo ""

# ---------- 4. MinIO 健康端点 ----------
echo ">>> 4/8 检查 MinIO 健康端点"
MINIO_HEALTH="$(docker compose --env-file .env -f compose.deploy.yml exec -T minio \
  curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/minio/health/live 2>/dev/null || true)"
if [[ "$MINIO_HEALTH" == "200" ]]; then
  ok "MinIO /minio/health/live → 200"
else
  fail "MinIO 健康端点异常（HTTP $MINIO_HEALTH）"
fi
echo ""

# ---------- 5. API /health ----------
echo ">>> 5/8 检查 API /health 端点"
API_HEALTH="$(docker compose --env-file .env -f compose.deploy.yml exec -T api \
  curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health 2>/dev/null || true)"
if [[ "$API_HEALTH" == "200" ]]; then
  ok "API /health → 200"
else
  fail "API /health 异常（HTTP $API_HEALTH）"
fi
echo ""

# ---------- 6. Web /healthz ----------
echo ">>> 6/8 检查 Web /healthz 端点"
WEB_HEALTHZ="$(docker compose --env-file .env -f compose.deploy.yml exec -T web \
  curl -s -o /dev/null -w '%{http_code}' http://localhost/healthz 2>/dev/null || true)"
if [[ "$WEB_HEALTHZ" == "200" ]]; then
  ok "Web /healthz → 200"
else
  fail "Web /healthz 异常（HTTP $WEB_HEALTHZ）"
fi
echo ""

# ---------- 7. 反向代理 ----------
echo ">>> 7/8 检查反向代理（公网访问）"
if [[ -z "$PUBLIC_URL" ]]; then
  skip "未传 --public-url，跳过反代验证。"
else
  # 7a. /healthz
  PUBLIC_HEALTHZ="$(curl -s -o /dev/null -w '%{http_code}' "${PUBLIC_URL%/}/healthz" 2>/dev/null || true)"
  if [[ "$PUBLIC_HEALTHZ" == "200" ]]; then
    ok "公网 ${PUBLIC_URL}/healthz → 200"
  else
    fail "公网 /healthz 异常（HTTP $PUBLIC_HEALTHZ）— 检查宝塔/Nginx 反代是否指向 127.0.0.1:8088"
  fi
  # 7b. /api/health（反代到 API）
  PUBLIC_API_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "${PUBLIC_URL%/}/api/health" 2>/dev/null || true)"
  if [[ "$PUBLIC_API_HEALTH" == "200" ]]; then
    ok "公网 ${PUBLIC_URL}/api/health → 200"
  else
    fail "公网 /api/health 异常（HTTP $PUBLIC_API_HEALTH）— 检查 Nginx location /api/ 反代配置"
  fi
fi
echo ""

# ---------- 8. Origin 校验 ----------
echo ">>> 8/8 检查 Origin 校验"
if [[ -z "$ALLOWED_ORIGIN" ]]; then
  skip "未传 --public-url，跳过 Origin 校验验证。"
else
  # 读取 .env 中的 ALLOWED_ORIGINS
  CONFIGURED_ORIGINS="$(grep -E '^ALLOWED_ORIGINS=' .env | cut -d'=' -f2- | tr -d '"' || true)"
  if [[ -z "$CONFIGURED_ORIGINS" ]]; then
    fail ".env 中 ALLOWED_ORIGINS 为空 — Origin 校验处于开发模式放行所有（不安全）"
    info "编辑 .env 设置：ALLOWED_ORIGINS=${ALLOWED_ORIGIN}"
    info "然后运行：docker compose --env-file .env -f compose.deploy.yml up -d --force-recreate api"
  else
    # 8a. 非法 Origin 应返回 403
    EVIL_ORIGIN="https://evil.example.com"
    EVIL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST -H "Origin: ${EVIL_ORIGIN}" -H "Content-Type: application/json" -d '{}' \
      "${PUBLIC_URL%/}/api/v1/onboarding" 2>/dev/null || true)"
    if [[ "$EVIL_STATUS" == "403" ]]; then
      ok "非法 Origin → 403（CSRF 防御生效）"
    else
      fail "非法 Origin 未被拦截（实际 HTTP $EVIL_STATUS，期望 403）"
    fi
    # 8b. 合法 Origin 不应因 Origin 被拒（应返回非 403 的业务错误，如 4xx/5xx 但不是 403）
    GOOD_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST -H "Origin: ${ALLOWED_ORIGIN}" -H "Content-Type: application/json" -d '{}' \
      "${PUBLIC_URL%/}/api/v1/onboarding" 2>/dev/null || true)"
    if [[ "$GOOD_STATUS" != "403" ]]; then
      ok "合法 Origin → HTTP $GOOD_STATUS（未被 Origin 校验拦截）"
    else
      fail "合法 Origin $ALLOWED_ORIGIN 也被 403 — 检查 .env 中 ALLOWED_ORIGINS 是否包含此域名"
    fi
  fi
fi
echo ""

# ---------- 汇总 ----------
echo "==================== 验证汇总 ===================="
echo "通过: $PASS"
echo "失败: $FAIL"
if [[ ${#FAILED_ITEMS[@]} -gt 0 ]]; then
  echo ""
  echo "失败项："
  for item in "${FAILED_ITEMS[@]}"; do
    echo "  - $item"
  done
fi
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "${RED}部署验证未通过，请按上述失败项排查。${RESET}"
  exit 1
fi

echo "${GREEN}部署验证全部通过！CoveChat 已就绪。${RESET}"
exit 0
