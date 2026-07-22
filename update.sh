#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
REF="main"
SKIP_BACKUP=0

usage() {
  cat <<'EOF'
用法 / Usage: ./update.sh [--ref main] [--skip-backup]

安全更新 CoveChat：检查本地修改、备份 PostgreSQL、拉取指定分支、重建容器并验证。
.env、PostgreSQL 和 MinIO Docker volumes 都会保留。
EOF
}

while (($#)); do
  case "$1" in
    --ref) [[ $# -ge 2 ]] || exit 2; REF="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数 / Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f .env ]] || { echo ".env 不存在，请先运行 ./deploy.sh" >&2; exit 1; }
random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n';
  else head -c 36 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; fi
}
if ! grep -q '^COVECHAT_ADMIN_PATH=' .env; then printf '\nCOVECHAT_ADMIN_PATH=/manage-%s\n' "$(random_secret | cut -c1-16)" >> .env; fi
if ! grep -q '^COVECHAT_ADMIN_TOKEN=' .env; then printf '\nCOVECHAT_ADMIN_TOKEN=%s\n' "$(random_secret)" >> .env; fi
chmod 600 .env

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1 || {
    echo "当前用户无权访问 Docker，请配置 docker 组或使用 sudo。" >&2
    exit 1
  }
  DOCKER=(sudo docker)
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "检测到已跟踪文件有本地修改，已停止更新，避免覆盖。请先提交或还原修改。" >&2
  git status --short >&2
  exit 1
fi

COMPOSE=("${DOCKER[@]}" compose --env-file .env -f compose.deploy.yml)
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if ((SKIP_BACKUP == 0)) && "${COMPOSE[@]}" ps --status running postgres --quiet | grep -q .; then
  mkdir -p backups
  chmod 700 backups
  echo "[1/4] 备份 PostgreSQL / Backing up PostgreSQL..."
  BACKUP_TMP="backups/.covechat-${STAMP}.dump.tmp"
  BACKUP_FILE="backups/covechat-${STAMP}.dump"
  trap 'rm -f "${BACKUP_TMP:-}"' EXIT
  "${COMPOSE[@]}" exec -T postgres pg_dump -U covechat -d covechat --format=custom > "$BACKUP_TMP"
  chmod 600 "$BACKUP_TMP"
  mv "$BACKUP_TMP" "$BACKUP_FILE"
else
  echo "[1/4] 跳过数据库备份 / Database backup skipped."
fi

echo "[2/4] 拉取 ${REF} / Fetching ${REF}..."
git fetch --prune --tags origin
if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  git checkout "$REF"
  git merge --ff-only "origin/$REF"
elif git show-ref --verify --quiet "refs/tags/$REF"; then
  git checkout --detach "$REF"
else
  echo "找不到远程分支或标签 / Unknown remote branch or tag: $REF" >&2
  exit 1
fi

echo "[3/4] 重建并滚动启动 / Rebuilding and restarting..."
"${COMPOSE[@]}" pull postgres redis minio
"${COMPOSE[@]}" up -d --build --pull always --remove-orphans

echo "[4/4] 验证更新 / Verifying..."
if ! ./deploy/verify.sh; then
  echo "更新后的健康检查失败。更新前提交: $PREVIOUS_COMMIT" >&2
  echo "请查看日志: docker compose --env-file .env -f compose.deploy.yml logs --tail=200" >&2
  echo "代码回退（数据库不会自动回退）: git checkout $PREVIOUS_COMMIT && ./deploy.sh" >&2
  exit 1
fi

echo "更新完成 / Update complete: $(git rev-parse --short HEAD)"
