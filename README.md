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

## 一键部署：全新 Linux 服务器

支持 Ubuntu/Debian、Rocky/Alma/CentOS 等常见 Linux。推荐至少 2 核 CPU、4 GB 内存、20 GB 可用磁盘。

### 推荐方式：从 GitHub 拉取并部署

服务器已经安装 Docker 时，复制执行下面的完整命令：

```bash
git clone https://github.com/txcxgzs/covechat.git /opt/covechat
cd /opt/covechat
chmod +x install.sh deploy.sh update.sh deploy/verify.sh
./deploy.sh
```

这段命令会从 GitHub 拉取最新的 `main` 源码。部署脚本会询问反向代理上游端口，直接回车使用默认 `8088`；也可以非交互执行 `./deploy.sh --port 9000`。随后脚本生成私密配置、构建镜像、启动服务并显示一次性安装令牌。

将域名的 HTTPS/WebSocket 反向代理指向脚本显示的上游地址，然后打开域名。首次启动页面会引导填写公网访问地址和安装令牌；配置完成后才会进入账号注册页面。需要自动化部署时，仍可使用 `./deploy.sh --domain chat.example.com --port 8088` 跳过网页域名向导。

反向代理端口必须在网页打开前确定，因此由部署脚本询问；域名属于应用安全配置，可以在网页中完成。公网地址必须使用完整 HTTPS Origin，例如 `https://chat.example.com`，不能包含路径。

### 服务器尚未安装 Docker

安装器同样会通过 Git 从 GitHub 拉取源码，并可选择安装 Docker。建议先下载并检查脚本，再执行：

```bash
curl -fL https://raw.githubusercontent.com/txcxgzs/covechat/main/install.sh -o /tmp/covechat-install.sh
less /tmp/covechat-install.sh
bash /tmp/covechat-install.sh --install-docker
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

安装器会检查依赖、通过 Git 从 GitHub 拉取源码、生成权限为 `0600` 的 `.env` 和随机强密码、配置 Origin、启动五个服务并执行健康检查。

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

后续发布新版本时，**不要再次执行 `git clone`，也不要删除原目录或 `.env`**。进入原安装目录运行项目更新器：

```bash
cd /opt/covechat
./update.sh
```

因此，首次部署命令只执行一次；以后每次更新只需执行上面两行。`update.sh` 内部会执行安全的 Git 拉取，并在更新代码前备份 PostgreSQL。不要使用简单的 `git pull && docker compose up`，因为它不会自动备份数据库，也不会执行完整的部署健康检查。

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
- `ALLOWED_ORIGINS` 可用于自动化部署，必须是精确 HTTPS Origin、不带末尾 `/`；留空时由首次网页向导安全写入数据库。
- `.env` 包含基础设施密码，必须保持私密并备份。

修改配置后：

```bash
docker compose --env-file .env -f compose.deploy.yml up -d --force-recreate
./deploy/verify.sh
```

## 数据库与图形化管理

当前版本没有内置的“绑定数据库”图形化页面，也没有完整管理后台。默认一键部署已经自动创建并绑定 PostgreSQL，连接关系由 [`compose.deploy.yml`](compose.deploy.yml) 和服务器上的私密 `.env` 管理：

- API 自动连接 Compose 内部的 `postgres:5432`。
- 数据保存在 Docker 的 `postgres-data` volume 中，更新和普通重启不会删除。
- PostgreSQL 端口默认不映射到公网，避免数据库直接暴露。
- 数据库密码由首次部署自动生成并写入权限为 `0600` 的 `.env`。

如果需要图形化查看数据库，可以另外部署 pgAdmin、Adminer 或使用宝塔数据库工具，但建议只通过本机、VPN 或 SSH 隧道访问，不要把 PostgreSQL `5432` 直接开放到公网。当前聊天用户注册和设备管理不依赖人工“绑定数据库”；容器启动时会自动连接并执行迁移。

### 已经安装 PostgreSQL 怎么办

不需要卸载。默认一键部署使用 Docker 内部独立的 PostgreSQL，并且不会把容器的 `5432` 映射到宿主机，因此通常不会与服务器已经安装的 PostgreSQL 冲突。宿主机 PostgreSQL 和 CoveChat 的容器数据库是两套相互独立的实例。

当前一键部署不支持在网页中绑定宿主机或第三方 PostgreSQL。若确实要改用外部数据库，需要自行调整 Compose 网络和 `DATABASE_URL`，同时确保数据库用户、TLS、访问控制、备份和迁移都已正确配置；不熟悉这些配置时建议保留默认容器数据库。

### 数据库连接或启动失败

先在项目目录执行：

```bash
cd /opt/covechat
docker compose --env-file .env -f compose.deploy.yml ps
docker compose --env-file .env -f compose.deploy.yml logs --tail=200 postgres api
docker compose --env-file .env -f compose.deploy.yml exec -T postgres pg_isready -U covechat -d covechat
./deploy/verify.sh
```

重点检查：

1. `.env` 中存在非空的 `POSTGRES_PASSWORD`，且文件没有被手动删除或替换。
2. 服务器磁盘空间充足，`postgres-data` volume 可以正常写入。
3. Docker 服务正常，`postgres` 容器不是持续重启状态。
4. 不要为了修复连接而运行 `docker compose down -v`，该命令会永久删除数据库 volume。

如果日志显示密码不一致，不要直接修改现有 `.env` 密码；数据库 volume 初始化后仍保存旧密码。应先备份现有数据，再根据日志和备份情况处理密码恢复或数据迁移。

如果首次网页向导误填了域名，可在服务器删除该项配置并重启 API，然后重新打开向导：

```bash
cd /opt/covechat
docker compose --env-file .env -f compose.deploy.yml exec -T postgres \
  psql -U covechat -d covechat -c "DELETE FROM deployment_settings WHERE setting_key = 'public_origin';"
docker compose --env-file .env -f compose.deploy.yml restart api
```

安装令牌保存在服务器 `.env` 的 `COVECHAT_SETUP_TOKEN` 中。不要把令牌发送给他人；向导成功后再次提交会被拒绝。

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
