# CoveChat

面向国际市场的开源端到端加密聊天项目。默认中文，可一键切换 English。

> **安全警告：** CoveChat 0.x 是尚未经过独立安全审计的实验性软件。
> 当前版本可用于部署测试和低风险试用，请勿用于高敏感或高风险通信。

## 当前可用范围

- 可安装 React/Vite PWA，中英双语，默认中文
- 用户名注册、设备身份、恢复码、本地加密保险库
- 单聊消息邮箱、WebSocket 在线投递和离线密文队列
- 官方 libsignal 协议核心的 PQXDH、后量子预密钥与逐消息 Ratchet
- 客户端加密云备份、回滚链和设备恢复
- 客户端分块加密附件及 S3 兼容对象存储
- PostgreSQL 持久化、MinIO、Redis 和反向代理一键部署

暂未完成生产级验收的功能包括：MLS 小群、多设备完整交互、举报管理和独立安全审计。

## 一键部署

需要安装并启动 Docker Desktop。PowerShell 中运行：

```powershell
.\deploy.ps1
```

脚本会生成包含随机基础设施密码的 `.env`，构建并启动 Web、API、
PostgreSQL、Redis 和 MinIO。默认仅在本机监听：

```text
http://127.0.0.1:8088
```

自定义反向代理上游端口：

```powershell
.\deploy.ps1 -Port 9000
```

随后将 Nginx、Caddy 或面板反向代理的 HTTP/WebSocket 上游设置为
`http://127.0.0.1:9000`。不要将 API、PostgreSQL、Redis 或 MinIO
端口直接暴露到公网。示例见 [deploy/Caddyfile.example](deploy/Caddyfile.example)。

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
明确提交，并通过 Rust/WASM 边界调用；浏览器端状态使用设备密钥加密后保存。

这些实现和测试不等同于独立密码学审计。任何公开部署都必须保留
`0.x experimental` 标识。详情见 [SECURITY.md](SECURITY.md) 和
[威胁模型](docs/security/threat-model.md)。

## License

AGPL-3.0-only
