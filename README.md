# CoveChat

面向国际市场的开源端到端加密聊天项目。默认中文，可一键切换 English。

> **安全警告：** CoveChat 0.x 是尚未经过独立安全审计的实验性软件。
> 当前版本可用于部署测试和低风险试用，请勿用于高敏感或高风险通信。

## 当前可用范围

- 可安装 React/Vite PWA，中英双语，默认中文
- 用户名注册、设备身份、恢复码、本地加密保险库
- 单聊与最多 50 个成员设备的 RFC 9420 MLS 小群
- 消息邮箱、WebSocket 在线投递和离线密文队列
- 官方 libsignal 协议核心的 PQXDH、后量子预密钥与逐消息 Ratchet
- 客户端加密云备份、回滚链和设备恢复
- 客户端分块加密附件及 S3 兼容对象存储
- PostgreSQL 持久化、MinIO、Redis 和反向代理一键部署

暂未完成生产级验收的功能包括：多设备完整交互、举报管理和独立安全审计。

## Linux 一键部署

需要安装 Docker Engine 和 Compose 插件：

```bash
chmod +x deploy.sh
./deploy.sh
```

自定义反向代理上游端口：

```bash
./deploy.sh --port 9000
```

脚本会使用系统安全随机源生成权限受限的 `.env`，构建并启动 Web、API、
PostgreSQL、Redis 和 MinIO。默认仅在服务器回环地址监听：

```text
http://127.0.0.1:8088
```

随后将 Nginx、Caddy 或面板反向代理的 HTTP/WebSocket 上游设置为
`http://127.0.0.1:8088`。不要将 API、PostgreSQL、Redis 或 MinIO
端口直接暴露到公网。示例见 [deploy/Caddyfile.example](deploy/Caddyfile.example)。

### 配置 Origin 允许列表（重要）

`deploy.sh` 生成的 `.env` 默认 `ALLOWED_ORIGINS=` 为空，表示开发模式放行所有
Origin（不安全）。**生产部署必须**编辑 `.env`，把公网域名填上：

```bash
vi .env
# 修改这一行（多个域名用逗号分隔，不含尾斜杠）：
# ALLOWED_ORIGINS=https://chat.example.com
```

保存后重建 API 容器使配置生效：

```bash
docker compose --env-file .env -f compose.deploy.yml up -d --force-recreate api
```

留空时服务端会打印 `Origin checks are disabled (development mode)` 警告。

### 部署后验证（在 Linux 服务器上跑）

`deploy/verify.sh` 一键验证 8 项：服务状态、PostgreSQL 迁移表、Redis 连通、
MinIO 健康、API `/health`、Web `/healthz`、反向代理、Origin 校验。

```bash
chmod +x deploy/verify.sh

# 只验证容器内部（不验反代、不验 Origin）
./deploy/verify.sh

# 同时验证反向代理和 Origin 校验（推荐，传入你的公网域名）
./deploy/verify.sh --public-url https://chat.example.com
```

退出码 `0` = 全部通过；`1` = 至少一项失败，按输出排查。

### 宝塔面板部署（小白推荐）

如果你用宝塔面板（BT Panel），按以下步骤操作（每一步都要做完）：

1. **登录宝塔面板**：浏览器打开 `http://你的服务器IP:8888`（宝塔默认端口）。

2. **安装 Docker 管理器**：
   - 左侧菜单 → 软件商店 → 搜索 `Docker管理器` → 点 `安装`。
   - 等待安装完成（约 1-3 分钟）。安装后左侧菜单会多出 `Docker` 项。

3. **拉取 CoveChat 代码**：
   - 左侧菜单 → 终端 → 执行：
     ```bash
     cd /www/wwwroot
     git clone https://github.com/txcxgzs/covechat.git
     cd covechat
     ```
   - 如果没装 git：`yum install -y git`（CentOS）或 `apt install -y git`（Ubuntu/Debian）。

4. **首次部署**：
   - 终端继续执行：
     ```bash
     chmod +x deploy.sh
     ./deploy.sh
     ```
   - 脚本会自动生成 `.env`（权限 0600，含随机强密码）并启动 5 个容器。

5. **配置 Origin 允许列表**（关键安全步骤）：
   - 终端执行 `vi .env`，找到 `ALLOWED_ORIGINS=` 这一行，改成你的域名：
     ```
     ALLOWED_ORIGINS=https://chat.你的域名.com
     ```
   - 按 `i` 进入插入模式编辑，按 `Esc` 后输入 `:wq` 保存退出。
   - 重建 API 容器：
     ```bash
     docker compose --env-file .env -f compose.deploy.yml up -d --force-recreate api
     ```

6. **在宝塔配置反向代理**（让公网通过 HTTPS 访问）：
   - 左侧菜单 → 网站 → 添加站点：
     - 域名：`chat.你的域名.com`
     - 根目录：任意（反代不读根目录）
     - PHP版本：纯静态
     - 点 `提交`。
   - 进入站点设置 → 反向代理：
     - 点 `添加反向代理`：
       - 代理名称：`covechat`
       - 目标URL：`http://127.0.0.1:8088`
       - 发送域名：`$host`
       - 勾选 `启用代理`，点 `提交`。
   - 进入站点设置 → SSL：
     - 选 `Let's Encrypt`，勾选你的域名，点 `申请`。
     - 申请成功后勾选 `强制HTTPS`。
   - **WebSocket 支持**：宝塔默认反代配置不含 WebSocket 升级头。进入站点设置 → 配置文件，在 `location /` 块内加三行：
     ```nginx
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     ```
     保存并重启 Nginx。

7. **跑部署验证脚本**：
   - 终端执行：
     ```bash
     cd /www/wwwroot/covechat
     chmod +x deploy/verify.sh
     ./deploy/verify.sh --public-url https://chat.你的域名.com
     ```
   - 看到 `部署验证全部通过！CoveChat 已就绪。` 即完成。

8. **日常维护命令**（终端执行）：
   ```bash
   cd /www/wwwroot/covechat
   # 查看服务状态
   docker compose --env-file .env -f compose.deploy.yml ps
   # 查看实时日志
   docker compose --env-file .env -f compose.deploy.yml logs -f
   # 停止服务
   docker compose --env-file .env -f compose.deploy.yml down
   # 更新代码并重新部署
   git pull && ./deploy.sh
   ```

常见问题：

- 反代后 WebSocket 连不上 → 第 6 步的三个 upgrade 头没加。
- `verify.sh` 报 `Origin 校验处于开发模式放行所有` → 第 5 步 `.env` 没改或没重建 api 容器。
- 容器启动失败 → 看 `docker compose logs` 找原因，常见是端口被占用（改 `.env` 里的 `COVECHAT_HTTP_PORT`）。

## Windows 一键部署

安装并启动 Docker Desktop 后，在 PowerShell 中运行：

```powershell
.\deploy.ps1
```

自定义端口：

```powershell
.\deploy.ps1 -Port 9000
```

Windows 部署同样需要在 `.env` 中设置 `ALLOWED_ORIGINS`（生产域名），留空 = 开发模式。

常用维护命令：

```powershell
docker compose --env-file .env -f compose.deploy.yml ps
docker compose --env-file .env -f compose.deploy.yml logs -f
docker compose --env-file .env -f compose.deploy.yml down
```

## 本地开发

开发服务默认仅绑定 `127.0.0.1`，端口可以配置：

```powershell
.\dev.ps1
.\dev.ps1 -WebPort 3000 -ApiPort 3001
```

反向代理只需指向 Web 地址，例如 `http://127.0.0.1:3000`。
`/api/*` 和 WebSocket 会由 Vite 转发到本地 API。

## 项目结构

- `apps/web`：React/Vite PWA
- `services/api`：Rust HTTP/WebSocket 投递服务
- `crates/crypto-core`：Rust/WASM 密码学边界
- `packages/protocol`：带版本的公共协议类型
- `docs/security`：威胁模型、密钥生命周期和数据流

## 安全状态

CoveChat 不会在解密失败时降级为明文。服务端只转发带版本的不透明密文信封，
附件密钥、原文件名和消息明文不会进入服务端模型。官方 libsignal 依赖固定到
明确提交，MLS 使用 OpenMLS 0.8.1；两者均通过 Rust/WASM 边界调用。浏览器端
Ratchet 与 MLS 状态使用相互域隔离的设备状态密钥加密后保存。一次性 Signal
预密钥和 MLS KeyPackage 使用后自动轮换并重新发布。

这些实现和测试不等同于独立密码学审计。任何公开部署都必须保留
`0.x experimental` 标识。详情见 [SECURITY.md](SECURITY.md) 和
[威胁模型](docs/security/threat-model.md)。

## License

AGPL-3.0-only
