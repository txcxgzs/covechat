# CoveChat

CoveChat 是面向国际市场的开源端到端加密聊天项目。首发客户端为可安装 PWA，界面默认中文，可一键切换 English。

> **安全警告**：CoveChat `0.x` 尚未经过独立安全审计，只适合部署测试和低风险试用。请勿将当前版本用于高敏感、高风险或人身安全相关通信。

## 当前能力

- 用户名注册、设备身份、恢复码与本地加密保险库
- 基于 libsignal 协议核心的 PQXDH、后量子预密钥与逐消息 Ratchet 单聊
- 基于 RFC 9420/OpenMLS 的 50 人以内加密小群
- 文本、图片、文件分块加密、离线密文邮箱和 WebSocket 投递
- 客户端加密云备份、设备恢复、密钥变更提示和安全码验证
- PostgreSQL、Redis、S3 兼容对象存储和仅暴露单一 Web 端口的 Compose 部署
- 中英双语、PWA、深色主题及 Telegram 启发的聊天交互动画

尚未完成生产级验收：完整多设备互操作、独立密码学审计、管理后台和大规模压力测试。因此项目持续显示 `experimental` 标识。

## 最快部署：全新 Linux 服务器

支持 Ubuntu/Debian、Rocky/Alma/CentOS 等常见 Linux。推荐至少 2 核 CPU、4 GB 内存、20 GB 可用磁盘。

### 方式一：服务器已经安装 Docker

```bash
git clone https://github.com/txcxgzs/covechat.git /opt/covechat
cd /opt/covechat
chmod +x install.sh deploy.sh update.sh deploy/verify.sh
./deploy.sh --domain chat.example.com
```

### 方式二：一条命令自动下载并部署

先下载脚本，检查内容后执行：

```bash
curl -fL https://raw.githubusercontent.com/txcxgzs/covechat/main/install.sh -o /tmp/covechat-install.sh
less /tmp/covechat-install.sh
bash /tmp/covechat-install.sh --install-docker --domain chat.example.com
```

`--install-docker` 会下载并运行 Docker 官方安装脚本；服务器已有 Docker 时请省略。默认安装目录为 `/opt/covechat`，默认仅监听：

```text
http://127.0.0.1:8088
```

常用安装参数：

```bash
bash /tmp/covechat-install.sh \
  --dir /www/wwwroot/covechat \
  --ref main \
  --domain chat.example.com \
  --host 127.0.0.1 \
  --port 9000
```

安装器会检查依赖、从 GitHub 下载源码、生成权限为 `0600` 的 `.env` 和随机强密码、配置 Origin、启动五个服务并执行健康检查。

## 反向代理与 HTTPS

公网只应暴露 Nginx/Caddy/宝塔提供的 `443`。不要把 API、PostgreSQL、Redis 或 MinIO 端口直接暴露到公网。

反向代理上游：

```text
http://127.0.0.1:8088
```

示例配置：[`Nginx`](deploy/nginx.reverse-proxy.example.conf) / [`Caddy`](deploy/Caddyfile.example)。反向代理必须支持 WebSocket：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 75s;
proxy_buffering off;
```

宝塔面板：新建纯静态站点，配置 SSL/强制 HTTPS，将整站反向代理到 `http://127.0.0.1:8088`，并启用 WebSocket。最后运行：

```bash
cd /www/wwwroot/covechat
./deploy/verify.sh --public-url https://chat.example.com
```

## 新版本如何更新

不要使用简单的 `git pull && docker compose up`。使用项目更新器：

```bash
cd /opt/covechat
./update.sh
```

更新器会：

1. 检查已跟踪文件的本地修改，有修改则停止以避免覆盖。
2. 在 `backups/` 创建带 UTC 时间戳的 PostgreSQL 备份。
3. 对目标分支执行 fast-forward-only 更新。
4. 拉取基础镜像，重新构建 Web/API 并原地更新容器。
5. 保留 `.env`、PostgreSQL volume 与 MinIO volume。
6. 等待健康检查并运行 `deploy/verify.sh`。

指定分支或版本标签：

```bash
./update.sh --ref main
# 发布标签可用后，例如：./update.sh --ref v0.2.0
```

失败时脚本会显示更新前提交。代码可以回退，但数据库迁移不会自动回退：

```bash
git checkout <更新前提交>
./deploy.sh
```

数据库备份位于 `backups/covechat-YYYYmmddTHHMMSSZ.dump`。还应使用服务器快照或异地备份保护 Docker volumes 与 `.env`。

## 日常维护

```bash
cd /opt/covechat
docker compose --env-file .env -f compose.deploy.yml ps
docker compose --env-file .env -f compose.deploy.yml logs -f --tail=200
./deploy/verify.sh --public-url https://chat.example.com
docker compose --env-file .env -f compose.deploy.yml down
./deploy.sh
```

不要运行 `docker compose down -v`，除非你明确要永久删除 PostgreSQL 和 MinIO 数据。

## `.env` 关键配置

首次部署自动生成 `.env`，后续部署或更新不会覆盖它。

```dotenv
COVECHAT_HTTP_HOST=127.0.0.1
COVECHAT_HTTP_PORT=8088
POSTGRES_PASSWORD=<自动生成>
MINIO_ROOT_USER=covechat
MINIO_ROOT_PASSWORD=<自动生成>
ALLOWED_ORIGINS=https://chat.example.com
```

- `COVECHAT_HTTP_HOST` 保持 `127.0.0.1`，只允许本机反向代理访问。
- `ALLOWED_ORIGINS` 公网部署必须设置为精确 HTTPS Origin，不带末尾 `/`；多个域名用逗号分隔。
- `.env` 包含基础设施密码，必须保持私密并备份。

修改配置后：

```bash
docker compose --env-file .env -f compose.deploy.yml up -d --force-recreate
./deploy/verify.sh
```

## 部署前必须知道

- 当前版本能进行实验性的端到端加密单聊、小群和附件通信，但不能宣称“媲美 Telegram 的已审计安全性”。
- 浏览器扩展、恶意软件、截图、键盘记录和完全失陷的终端不在保护范围内。
- 公网必须使用 HTTPS；恢复码丢失后服务端无法代用户找回。
- 上线前必须备份 `.env`、PostgreSQL 与 MinIO 数据。

更多安全边界见 [`SECURITY.md`](SECURITY.md) 和 [`威胁模型`](docs/security/threat-model.md)。

## 本地开发

```powershell
.\dev.ps1
.\dev.ps1 -WebPort 3000 -ApiPort 3001
```

开发服务默认只绑定 `127.0.0.1`。反向代理指向 Web 端口即可，`/api/*` 和 WebSocket 会被转发到 Rust API。

## English quick start

CoveChat is experimental, unaudited end-to-end encrypted chat software. Do not use `0.x` for high-risk communications.

```bash
git clone https://github.com/txcxgzs/covechat.git /opt/covechat
cd /opt/covechat
chmod +x install.sh deploy.sh update.sh deploy/verify.sh
./deploy.sh --domain chat.example.com
```

Point your HTTPS/WebSocket reverse proxy to `http://127.0.0.1:8088`. Update without replacing `.env` or Docker volumes:

```bash
cd /opt/covechat
./update.sh
```

The updater refuses dirty tracked files, creates a PostgreSQL backup, fast-forwards the selected ref, rebuilds containers, and runs health checks.

## 项目结构

- `apps/web`：React/Vite PWA
- `services/api`：Rust HTTP/WebSocket 服务
- `crates/crypto-core`：Rust/WASM 密码学核心
- `packages/protocol`：公共协议类型
- `deploy.sh`：已有源码目录的一键部署
- `install.sh`：全新服务器自动下载与部署
- `update.sh`：保留配置和数据的安全更新
- `deploy/verify.sh`：部署后健康检查

## 设计参考与鸣谢 / Design acknowledgements

CoveChat 的信息层级、聊天交互节奏和动画研究参考了开源项目 [Telegram Web K](https://github.com/morethanwords/tweb)（GPL-3.0）。CoveChat 没有引入 Telegram 的协议、品牌资产或加密实现；壁纸、组件、声音反馈与视觉资产均为独立实现。Telegram 是 Telegram Messenger LLP 的商标。

## License

AGPL-3.0-only
