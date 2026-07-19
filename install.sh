#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="https://github.com/txcxgzs/covechat.git"
INSTALL_DIR="${COVECHAT_INSTALL_DIR:-/opt/covechat}"
REF="${COVECHAT_REF:-main}"
INSTALL_DOCKER=0
DEPLOY_ARGS=()
SUDO=()
if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || { echo "需要 root 或 sudo / Root or sudo is required." >&2; exit 1; }
  SUDO=(sudo)
fi

usage() {
  cat <<'EOF'
用法 / Usage:
  ./install.sh [--dir /opt/covechat] [--ref main] [--install-docker]
               [--domain chat.example.com] [--host 127.0.0.1] [--port 8088]

在空白 Linux 服务器上自动下载 CoveChat 并启动。默认不会自动安装 Docker；
传 --install-docker 才会使用 Docker 官方安装脚本。
EOF
}

while (($#)); do
  case "$1" in
    --dir) [[ $# -ge 2 ]] || exit 2; INSTALL_DIR="$2"; shift 2 ;;
    --ref) [[ $# -ge 2 ]] || exit 2; REF="$2"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --domain|--host|--port) [[ $# -ge 2 ]] || exit 2; DEPLOY_ARGS+=("$1" "$2"); shift 2 ;;
    --skip-verify) DEPLOY_ARGS+=("$1"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数 / Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    "${SUDO[@]}" apt-get update && "${SUDO[@]}" apt-get install -y git ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then
    "${SUDO[@]}" dnf install -y git ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then
    "${SUDO[@]}" yum install -y git ca-certificates curl
  else
    echo "请先安装 git 和 curl / Install git and curl first." >&2
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  if ((INSTALL_DOCKER == 0)); then
    echo "未找到 Docker。重新运行并添加 --install-docker，或手动安装 Docker Engine。" >&2
    exit 1
  fi
  command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
  TEMP_INSTALLER="$(mktemp)"
  trap 'rm -f "$TEMP_INSTALLER"' EXIT
  curl --fail --show-error --location https://get.docker.com -o "$TEMP_INSTALLER"
  echo "即将运行 Docker 官方安装脚本 / Running the official Docker installer..."
  "${SUDO[@]}" sh "$TEMP_INSTALLER"
  "${SUDO[@]}" usermod -aG docker "${SUDO_USER:-$USER}" || true
fi

if [[ -e "$INSTALL_DIR/.git" ]]; then
  echo "目录已存在，转入更新流程 / Existing checkout found; updating."
  exec "$INSTALL_DIR/update.sh" --ref "$REF"
fi
[[ ! -e "$INSTALL_DIR" ]] || { echo "目标目录非空且不是 Git 仓库: $INSTALL_DIR" >&2; exit 1; }
"${SUDO[@]}" mkdir -p "$INSTALL_DIR"
"${SUDO[@]}" chown "${USER}:$(id -gn)" "$INSTALL_DIR"

git clone --branch "$REF" --single-branch "$REPOSITORY" "$INSTALL_DIR"
cd "$INSTALL_DIR"
chmod +x deploy.sh update.sh deploy/verify.sh
exec ./deploy.sh "${DEPLOY_ARGS[@]}"
