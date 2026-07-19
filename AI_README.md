# AI 必读文件（每次对话开始必看）

> 用途：记录用户习惯、项目环境、关键规则，避免 AI 在长对话中遗忘。
> 每次接手开发前，AI 必须先读完本文件，再读 `PROJECT_CONTEXT.md`。

## 1. 用户硬性规则（不可违反）

1. **语言**：始终用中文回复；代码注释也用中文（除非另有指示）。
2. **文档**：写完代码必须自检 bug；文档要写到小白能看懂，包括安装、使用、配置、部署、项目结构、每个文件/函数/类的作用，附快速导航。
3. **宝塔面板**：用户是小白，部署偏好宝塔面板，文档要详细说明每一步操作。
4. **AI 必读**：每次对话开始必须查看本文件，避免遗忘；每次对话都要把用户的新要求、新环境信息追加到本文件。
5. **不要在 thought 板块写无意义内容**（如重复贴代码、复述插件错误）。
6. **代码混淆**：手动命名变量，不用脚本批量重命名；删除无用混淆代码；逐文件人工确认；核心和积木部分要深入分析。
7. **KittenCloudFunction**：直接用代码版链接，不研究挂载方式。
8. **敏感配置**：API 等敏感配置必须存在数据库里，不允许放环境变量；终端工具箱要能直接改库以开关 Geetest / hCaptcha。

## 2. 项目环境

- 项目路径：`c:\Users\Administrator\Desktop\covechat`
- 操作系统：Windows（PowerShell），但部署目标是 Linux + 宝塔面板。
- 时区：`Asia/Shanghai`
- 仓库：https://github.com/txcxgzs/covechat
- 当前版本：`0.1.0-experimental`（未经独立安全审计，禁止声称"绝对安全"）
- License：AGPL-3.0-only

### Windows 本机 Rust 已验证配置（来自 PROJECT_CONTEXT.md 第 7 节）

```powershell
$tool="$env:USERPROFILE\.rustup\toolchains\1.91.0-x86_64-pc-windows-msvc\bin"
$env:CARGO_TARGET_DIR='D:\covechat-target'
$env:CARGO_HOME='D:\covechat-cargo-home'
$env:RUSTC="$tool\rustc.exe"
$env:RUSTDOC="$tool\rustdoc.exe"
$env:PROTOC='D:\protoc-35.1\bin\protoc.exe'
& "$tool\cargo.exe" test --workspace --all-features
```

注意：本机 Clippy 可能因 `clippy-driver` 1.94 与 Rust 1.91 产物混用报 `E0514`，这不是代码问题。Clippy 交给 GitHub CI 跑。

## 3. 项目结构快速导航

```
covechat/
├─ apps/web/              # React + Vite PWA 前端（中英双语，默认中文）
│  ├─ src/
│  │  ├─ crypto-wasm/     # Rust 编译出的 WASM 包装
│  │  ├─ security/        # 安全面板相关 API 与 UI 模块
│  │  │  ├─ SecurityGate.tsx / api.ts / attachments.ts / backup.ts
│  │  │  ├─ groups.ts / history.ts / signal.ts / trust.ts / vault.ts
│  │  ├─ App.tsx          # 主应用
│  │  ├─ data.ts / i18n.ts / main.tsx / styles.css
│  ├─ e2e/smoke.mjs       # Playwright 冒烟测试
│  ├─ Dockerfile / vite.config.ts / index.html
├─ services/api/          # Rust + Axum HTTP/WebSocket 投递服务
│  ├─ src/
│  │  ├─ main.rs / event_bus.rs / object_store.rs
│  │  ├─ persistence.rs / rate_limit.rs
│  ├─ migrations/         # SQLx 迁移
│  │  ├─ 0001_durable_store.sql / 0002_abuse_controls.sql
│  ├─ Dockerfile / Cargo.toml
├─ crates/crypto-core/    # Rust/WASM 密码学边界（libsignal + OpenMLS）
│  ├─ src/
│  │  ├─ lib.rs / mls_protocol.rs / signal_protocol.rs / signal_store.rs
├─ packages/protocol/     # 带版本的公共协议类型（TS）
├─ deploy/                # Caddyfile.example / nginx.conf
├─ docs/
│  ├─ architecture.md     # 信任边界与组件职责
│  ├─ design/             # 设计稿
│  ├─ security/           # 威胁模型、密钥生命周期、数据流、协议状态
├─ .github/workflows/ci.yml
├─ compose.deploy.yml / docker-compose.yml
├─ deploy.sh / deploy.ps1 / dev.ps1 / build-wasm.ps1
├─ PROJECT_CONTEXT.md     # ★ 项目上下文与续作清单（最重要）
├─ README.md / SECURITY.md / AI_README.md（本文件）
```

### 信任边界（来自 architecture.md）

- `crypto-core`：拥有密钥与密码学变换，所有加密操作只在这里。
- `web`：负责展示、本地加密持久化、用户授权。
- `api`：只持有公共身份记录和不透明密文路由，看不到明文。
- `protocol`：带版本的公共线协议类型。

## 4. 当前开发状态（截至 2026-07-18）

### 已完成并已提交

- 提交 `ba49f22`：加密附件传输、信任/安全码、历史/备份、举报/拉黑、Redis 限流。
- 提交 `22bdaf7`：单聊定时消失消息 + 真实会话列表（已移除硬编码联系人）。
- 提交 `a4a1a7a`：Redis Pub/Sub 跨 API 实例邮箱事件总线。

### 本轮（2026-07-18）未提交的修改

续作清单第 1/3/4/5/6 项 + 第 7 项部署验证脚本/文档（未在 Linux 真机跑过）+ 第 9 项安全/架构文档更新 + 第 8 项前端 E2E Origin/限流测试脚本（未在 dev server 跑过），本机自检全绿。已提交推送 b1adb88（第 1-9 轮），第 10 轮 E2E 脚本待提交。

**服务端 `services/api/src/main.rs`**：
- 新增 5 个业务测试（举报/拉黑/备份读取/恢复会话读备份/过期信封处理）+ 3 个辅助函数
- 新增 3 个 cleanup_once 测试 + 1 个测试辅助
- 新增 6 个 Origin/限流测试（allowed_origins_default/is_allowed/anonymous_rate_limit 2 个/read_directory/create_challenge）
- 重构 `cleanup_loop`：提取纯函数 `cleanup_once`
- 补全清理类别：challenges / recovery_challenges / sessions / recovery_sessions
- **新增 `AllowedOrigins` 结构**：从 `ALLOWED_ORIGINS` env 读取（逗号分隔），空=开发模式放行
- **新增 `require_origin` 中间件**：对 POST/PUT/DELETE 校验 Origin 头（CSRF 纵深防御）
- **新增 `anonymous_rate_limit` 函数**：基于 X-Forwarded-For 的 IP 限流，无 Redis 降级放行
- `onboard_account` 加匿名限流（5 次/小时，防批量注册）
- `create_challenge` 加匿名限流（10 次/分钟，防登录轰炸）
- `create_recovery_challenge` 加匿名限流（5 次/小时，防恢复码爆破）
- `read_directory` 加认证限流（60 次/分钟，防用户名枚举）
- `events` (WebSocket) handler 手动校验 Origin（WebSocket 升级是 GET，不经过中间件）
- `AppState` 新增 `allowed_origins` 字段

**前端 `apps/web/src/security/vault.ts`**：
- `MlsGroupMetadata` 新增 3 个可选字段（向后兼容）：`adminDeviceIds` / `invitePolicy` / `memberLeafIndices`

**前端 `apps/web/src/security/groups.ts`**：
- `updateMetadata` 同步维护 `memberLeafIndices`（deviceId → leafIndex 映射）+ 兼容旧数据补默认值
- `createEncryptedGroup` 初始化创建者为管理员 + 默认邀请策略 `admins`
- `addGroupMember` 新增邀请策略校验（`admins` 策略下非管理员拒绝）
- `removeGroupMember` 参数从 `leafIndex` 改为 `memberDeviceId`，内部通过映射查 leafIndex；加管理员校验 + 禁止 self-removal
- 新增 `isGroupAdmin(profile, groupId)` 导出函数
- 新增 `setGroupInvitePolicy(profile, session, groupId, policy)` 导出函数

**前端 `apps/web/src/App.tsx`**：
- GroupWorkspace 新增 `isAdmin` 派生状态
- 新增 3 个处理函数：`removeMember` / `changeInvitePolicy` / `leaveGroup`
- UI 新增可折叠的"群管理"面板：成员列表（带管理员标签 + 移除按钮）+ 邀请策略单选切换（仅管理员可见）+ 退出群组按钮
- 群头部加管理员徽章
- Chat 新增 `uploadProgress` / `pendingFile` 状态 + `formatBytes` 辅助函数
- `uploadAttachment` 改造：配额前置校验（>100MB 直接拒绝）+ onProgress 回调驱动进度条 + 失败保留 pendingFile 供重试
- UI 新增进度条（百分比 + 已上传/总字节 + 块数）+ 失败重试/取消按钮

**前端 `apps/web/src/security/attachments.ts`**：
- 新增 `UploadProgress` 类型 + `ATTACHMENT_CHUNK_MAX_RETRIES` 常量
- 新增 `uploadChunkWithRetry`：单块上传失败重试 3 次（指数退避 500ms→1s→2s）；4xx（除 429）不重试
- `encryptAndUploadAttachment` 新增 `onProgress` 回调参数 + 配额前置校验（明确错误信息）

**前端 `apps/web/src/i18n.ts`**：新增 17 个中英文 key（群管理 12 + 附件上传 5：uploadProgress/retryUpload/quotaExceeded/uploadFailed/cancelUpload）

**前端 `apps/web/src/styles.css`**：新增群管理面板样式 + 附件上传进度条 + 重试栏样式

**部署配置 `compose.deploy.yml`**：api 服务 environment 新增 `ALLOWED_ORIGINS: "${ALLOWED_ORIGINS:-}"` 透传（修复第 6 轮遗漏：部署时 Origin 校验会一直处于开发模式放行所有的 bug）

**部署脚本 `deploy.sh` / `deploy.ps1`**：
- `.env` 模板新增 `ALLOWED_ORIGINS=` 字段 + 中文注释说明（留空=开发模式，生产必须填公网域名）
- 首次生成 `.env` 后打印黄色警告，提示用户编辑设置 ALLOWED_ORIGINS
- `deploy.sh` 末尾新增引导：跑 `deploy/verify.sh --public-url` 验证 + 设置 ALLOWED_ORIGINS 后重建 api 容器
- `deploy.ps1` 加 UTF-8 BOM（PowerShell 5.1 的 ParseFile 不识别无 BOM 的 UTF-8 中文，会误判 here-string 终结符）

**新建 `deploy/verify.sh`**（部署后验证脚本，8 项检查）：
1. docker compose ps 服务状态（web/api/postgres/redis/minio 5 个服务 healthy/running）
2. PostgreSQL 10 张迁移表全部建成（accounts/devices/envelopes/delivery_counters/idempotency_keys/backups/attachments/attachment_chunks/abuse_reports/user_blocks）
3. Redis PING → PONG
4. MinIO /minio/health/live → 200
5. API /health → 200
6. Web /healthz → 200
7. 反向代理：公网 /healthz + /api/health → 200（需传 --public-url）
8. Origin 校验：非法 Origin POST → 403；合法 Origin POST → 非 403（需传 --public-url）

**README.md**：扩展"Linux 一键部署"章节，新增三个子章节：
- "配置 Origin 允许列表（重要）"：说明 .env 中 ALLOWED_ORIGINS 留空=开发模式不安全，生产必须填域名
- "部署后验证（在 Linux 服务器上跑）"：引用 deploy/verify.sh，给出两种用法
- "宝塔面板部署（小白推荐）"：8 步详细操作（登录宝塔→装 Docker→拉代码→部署→配 Origin→配反代+SSL+WebSocket 升级头→跑 verify→日常维护命令）+ 常见问题排查

**安全/架构文档更新（第 9 项）**：
- `docs/architecture.md`：重写。原内容过时（说 Redis 仅用于通知、S3 尚未接入）。新增 Durable storage / Redis（限流+Pub/Sub 双角色）/ Object storage（MinIO）/ Background cleanup（cleanup_once 纯函数）/ Request defences（Origin 校验+匿名限流+认证限流+body 大小限制）/ Limitations 章节
- `docs/security/threat-model.md`：Adversaries 新增 CSRF 和滥用（批量注册/登录轰炸/恢复码爆破/用户名枚举）两类；Security invariants 新增第 8-10 条（Origin allow-list / Redis 限流降级 / cleanup 后台任务）
- `docs/security/data-flow.md`：重写。Message delivery 补充 directory 限流和 require_origin 中间件环节 + Redis Pub/Sub 跨实例事件；新增 Rate-limited endpoints 表（4 个端点+scope+limit+purpose）+ Background cleanup 章节 + Telemetry 章节
- `SECURITY.md`：新增"Production deployment requirements"章节（ALLOWED_ORIGINS/REDIS_URL/DATABASE_URL/S3_ENDPOINT 必须设置 + 不暴露内部端口 + 反代必须转发 WebSocket 和 X-Forwarded-For + 引用 deploy/verify.sh）
- `docs/security/protocol-state.md` 和 `docs/security/key-lifecycle.md` 不需要更新（第 6 轮 Origin/限流不改变协议状态机或密钥生命周期）

### 本机自检结果

- `cargo test -p covechat-api`：22 passed（原 16 + 新 6）
- `cargo fmt --all -- --check`：通过
- `npm test -w @covechat/web`：3 passed
- `npm run build -w @covechat/web`：tsc 严格类型检查 + vite 构建成功
- `deploy.ps1` PowerShell `ParseFile`：0 errors（加 UTF-8 BOM 后；不加 BOM 时中文 here-string 被误判）
- `deploy.sh` `bash -n`：exit 0（用 Git Bash 验证）
- `deploy/verify.sh` `bash -n`：exit 0（用 Git Bash 验证）
- `compose.deploy.yml` YAML：OK（用 Python yaml.safe_load 验证）
- 安全/架构文档更新：纯 markdown，无代码可测试；已人工核对所有引用的环境变量名/端点/限制值与 main.rs 代码一致

### 第 7 项部署验证的未完成部分（需用户在 Linux 服务器上跑）

本机 Windows 无 WSL，无法跑真实 Linux Docker 部署。以下需用户在 Linux 服务器（如宝塔面板服务器）上执行后反馈结果：
1. `git clone` + `./deploy.sh` 启动 5 个容器
2. 编辑 `.env` 设置 `ALLOWED_ORIGINS=https://你的域名`，重建 api 容器
3. 宝塔面板配置反代 + SSL + WebSocket 升级头
4. 跑 `./deploy/verify.sh --public-url https://你的域名` 验证 8 项全 PASS
5. 把验证脚本输出贴回来，确认第 7 项完成

### 续作清单（按 PROJECT_CONTEXT.md 第 7 节顺序，已剔除完成项）

1. ~~补测试~~ ✅ 本轮完成服务端举报/拉黑/备份/过期 + 前端 i18n；剩余：身份变化前端测试（需 jsdom + crypto polyfill，成本高）、备份 v2 服务端集成测试（需 PostgreSQL）、Redis 限流集成测试（需 Redis）。
2. **Redis Pub/Sub CI 验证**：用两个 API 实例做真实通知测试（本机 Windows 编译会 OOM，交给 Linux / CI）。
3. ~~过期数据清理后台任务~~ ✅ 本轮完成：`cleanup_once` 纯函数补全 challenges/recovery_challenges/sessions/recovery_sessions 清理 + 3 个单元测试。
4. ~~群管理员 UI~~ ✅ 本轮完成：移除成员（通过 deviceId 查 leafIndex）、邀请策略切换（anyone/admins）、退出群组、管理员徽章、成员列表；管理员权限校验在 groups.ts 层强制。剩余：设备撤销触发群 epoch 更新的 UI（需服务端 device revocation 接口配合）。
5. ~~附件断点续传~~ ✅ 本轮完成：上传进度条（百分比+字节+块数）、单块失败重试（3次指数退避，4xx 不重试）、配额前置校验（>100MB 拒绝）、失败重试/取消按钮。剩余：真正的断点续传（记录已上传块，重试时跳过）需服务端支持 chunk 存在性查询接口。
6. ~~统一 Origin 校验~~ ✅ 本轮完成：`AllowedOrigins` 结构从 `ALLOWED_ORIGINS` env 读取；`require_origin` 中间件对 POST/PUT/DELETE 校验（CSRF 纵深防御）；`anonymous_rate_limit` 函数基于 X-Forwarded-For 做 IP 限流（无 Redis 降级放行）；应用到 onboard_account(5/h)、create_challenge(10/m)、create_recovery_challenge(5/h)、read_directory(60/m authenticated)；events WebSocket handler 手动校验 Origin（GET 不经过中间件）；新增 6 个单元测试。剩余：账户级限流（按 deviceId 而非 IP，需 Redis sorted set）、Origin 校验集成测试（需启动真实服务端 + HTTP 客户端）。
7. **真实 Linux Docker 部署验证**：本轮完成脚本/文档（`deploy/verify.sh` 8 项验证 + `compose.deploy.yml` 透传 `ALLOWED_ORIGINS` + `deploy.sh`/`deploy.ps1` .env 模板补字段 + README 宝塔面板 8 步部署文档）。**剩余**：用户需在 Linux 服务器上真实跑一次 `./deploy.sh` + `./deploy/verify.sh --public-url`，把验证输出贴回来确认 8 项全 PASS。本机 Windows 无 WSL 无法跑。
8. **多浏览器 E2E / 故障注入 / 压力测试 / 模糊测试**：本轮新建 `apps/web/e2e/origin-rate-limit.mjs`（4 个测试用例：非法 Origin POST→403 / 开发模式无 Origin 放行 / 限流 11 次→429 / WebSocket 非法 Origin→403），用 Node 内置 fetch + http 模块（不依赖 Playwright/Chrome），用环境变量 COVECHAT_ALLOWED_ORIGIN / COVECHAT_REDIS_URL 控制是否跑（无 Redis/无 Origin 校验时自动 skip）。package.json 新增 `test:e2e:origin` 脚本。**剩余**：需启动 dev server + 后端 + 可选 Redis 后跑 `npm run test:e2e:origin`；smoke.mjs 仍需启动 Chrome 本机验证；故障注入/压测/模糊测试未做。
9. **更新协议文档、威胁模型、运维手册、安全响应政策**：本轮完成 architecture.md 重写 + threat-model.md 补充 CSRF/滥用 adversary 和 3 条新 invariant + data-flow.md 重写含限流端点表 + SECURITY.md 新增生产部署要求章节。protocol-state.md 和 key-lifecycle.md 不需要更新。**剩余**：运维手册（docs/ops-runbook.md）尚未新建，需用户确认是否要新建（含监控/备份/升级/故障排查）；README 的"宝塔面板部署"章节已覆盖基本运维操作。
10. iOS/Android 原生客户端（后期）。

完整未完成清单见 `PROJECT_CONTEXT.md` 第 6 节（共 22 项）。

## 5. 每次提交前的稳定批次检查（PROJECT_CONTEXT.md 第 7 节）

```powershell
npm run build -w @covechat/web
npm test --workspaces --if-present
cargo fmt --all -- --check
cargo test --workspace --all-features
git diff --check
git add ...
git commit -m "..."
git push origin main
gh run list --repo txcxgzs/covechat --limit 3
```

## 6. 安全红线（SECURITY.md）

- 不得自创密码学协议或静默降级。
- 不得日志记录明文、密钥、恢复码、安全码、信封正文。
- 未知协议版本和无效签名必须拒绝。
- 服务端可用性丧失不得转化为机密性丧失。
- 身份密钥变化时暂停发送，直到用户确认。

## 7. 对话追加记录

- **2026-07-19（接手复核）**：用户要求继续推进并做好 Telegram 风格动画。已核对远端 `8b3ddd5` CI 全绿；完成主聊天壳第一轮视觉与动画、桌面/390px 浏览器验证，并修复会话过滤依赖和安全抽屉聊天对象展示。安全复核确认“所有成员可邀请”和“退出群组”原实现不可信：现暂时强制管理员成员变更、拒绝已知非管理员 commit，并将按钮明确改为“在此设备隐藏群组”。真正的 MLS 策略同步、安全自助退群和附件跨刷新续传仍未完成，禁止在文档中写成已完成。
- **2026-07-19（续作第二批）**：实现附件真正分块续传：服务端上传者状态接口 + 本地设备密钥加密续传状态 + 完整文件指纹校验 + 跳过已上传块；明文文件不落 IndexedDB。新增每会话 1000 条历史上限、显式 PWA 安全更新提示、备份 409 重试，并禁止设备本地附件续传秘密进入云备份。跨设备备份状态合并仍未完成。

- **2026-07-18（第 1 轮）**：首次接手。用户要求阅读项目、查看进度文档、准备接手开发。已确认工作区干净，下一步从续作清单第 1 项（补测试）开始。
- **2026-07-18（第 2 轮）**：用户说"推进开发"。按续作清单第 1 项补测试：
  - 服务端 `services/api/src/main.rs` 新增 5 个测试（举报/拉黑/备份读取/恢复会话读备份/过期处理）+ 3 个辅助函数
  - 前端 `apps/web/src/App.test.tsx` 增强 1 个测试 + 新增 1 个 i18n 非空校验测试
  - 本机自检全绿（cargo test 13 passed / npm test 3 passed / web build 成功 / cargo fmt 通过）
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 3 轮）**：用户说"接着完成，确保高质量"。按续作清单第 3 项做过期数据清理：
  - 重构 `cleanup_loop`：提取纯函数 `cleanup_once(&mut Store, now) -> Vec<(Uuid, u32)>`，S3 删除在锁外做避免长持锁
  - 补全清理类别（PROJECT_CONTEXT 第 6 节第 8 项）：原只清 idempotency/envelopes/attachments，现新增 challenges / recovery_challenges / sessions / recovery_sessions
  - 新增 3 个 cleanup_once 单元测试 + `store_with_mixed_expiry` 测试辅助（覆盖 7 类条目的过期/存活混合场景）
  - 本机自检全绿（cargo test 16 passed / cargo fmt 通过）
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 4 轮）**：用户说"继续，不要停"。按续作清单第 4 项做群管理员 UI：
  - 数据模型：`MlsGroupMetadata` 新增 3 个可选字段（adminDeviceIds / invitePolicy / memberLeafIndices），向后兼容
  - groups.ts：管理员初始化、邀请策略校验、deviceId→leafIndex 映射、新增 isGroupAdmin/setGroupInvitePolicy
  - App.tsx：可折叠群管理面板（成员列表+移除按钮+邀请策略单选+退出群组）、管理员徽章、3 个处理函数
  - i18n.ts：12 个中英文 key 对齐
  - styles.css：管理面板完整样式
  - 本机自检全绿（cargo test 16 passed / cargo fmt 通过 / npm test 3 passed / web build 成功）
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 5 轮）**：用户说"继续"。按续作清单第 5 项做附件断点续传：
  - attachments.ts：新增 UploadProgress 类型 + uploadChunkWithRetry（3 次指数退避，4xx 除 429 外不重试）+ encryptAndUploadAttachment 加 onProgress 回调 + 配额前置校验
  - App.tsx：uploadProgress/pendingFile 状态 + formatBytes 辅助函数 + uploadAttachment 改造（配额校验+进度回调+失败保留 pendingFile）+ 进度条 UI（百分比+字节+块数）+ 重试/取消按钮
  - i18n.ts：5 个中英文 key（uploadProgress/retryUpload/quotaExceeded/uploadFailed/cancelUpload）
  - styles.css：进度条 + 重试栏样式
  - 本机自检全绿（cargo test 16 passed / cargo fmt 通过 / npm test 3 passed / web build 成功）
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 6 轮）**：用户说"继续"。按续作清单第 6 项做统一 Origin 校验 + 限流：
  - main.rs：新增 `AllowedOrigins` 结构（from_env / is_empty / is_allowed）从 `ALLOWED_ORIGINS` env 读取逗号分隔列表，空=开发模式
  - main.rs：新增 `require_origin` 中间件（from_fn_with_state），对 POST/PUT/DELETE 校验 Origin 头，空列表放行（开发模式）；用 `from_fn_with_state(state.clone(), require_origin)` 注册到 router
  - main.rs：新增 `anonymous_rate_limit` 函数，基于 `X-Forwarded-For` 头取首个 IP 做 Redis INCR 限流，无 Redis 降级放行；`authenticated_rate_limit` 复用同一逻辑但 scope 不同
  - main.rs：限流应用——onboard_account 5/h（防批量注册）、create_challenge 10/m（防登录轰炸）、create_recovery_challenge 5/h（防恢复码爆破）、read_directory 60/m authenticated（防用户名枚举）
  - main.rs：events (WebSocket) handler 手动校验 Origin（WebSocket 升级是 GET 请求，不经过 require_origin 中间件）
  - main.rs：AppState 新增 `allowed_origins: AllowedOrigins` 字段
  - main.rs：新增 6 个单元测试（allowed_origins_default_is_empty_development_mode / allowed_origins_is_allowed_matches_exact / anonymous_rate_limit_passes_without_redis / anonymous_rate_limit_uses_anonymous_when_no_xff / read_directory_works_without_redis_rate_limit / create_challenge_passes_rate_limit_without_redis）
  - 本机自检全绿（cargo test 22 passed 原 16 + 新 6 / cargo fmt 通过 / npm test 3 passed / web build 成功）
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 7 轮）**：用户选"推进第 7 项部署验证"。本机 Windows 无 WSL 无法跑真实 Linux Docker 部署，改为准备脚本+文档让用户在 Linux 服务器上跑：
  - 发现并修复第 6 轮遗漏 bug：`compose.deploy.yml` 没透传 `ALLOWED_ORIGINS`，部署时 Origin 校验会一直处于开发模式放行所有 → 补 `ALLOWED_ORIGINS: "${ALLOWED_ORIGINS:-}"` 到 api 服务 environment
  - `deploy.sh` / `deploy.ps1`：.env 模板补 `ALLOWED_ORIGINS=` 字段 + 中文注释 + 首次生成后黄色警告提示用户编辑
  - `deploy.ps1` 加 UTF-8 BOM：PowerShell 5.1 的 `ParseFile` 不识别无 BOM 的 UTF-8 中文，会误判 here-string 终结符（实测确认）
  - `deploy.sh` 末尾新增引导：跑 `deploy/verify.sh --public-url` 验证 + 设置 ALLOWED_ORIGINS 后重建 api 容器
  - 新建 `deploy/verify.sh`（8 项验证脚本）：docker compose ps 状态 / PostgreSQL 10 张迁移表 / Redis PING / MinIO 健康 / API /health / Web /healthz / 反代公网访问 / Origin 校验（非法→403，合法→非403）；支持 `--public-url` 参数；颜色输出 + 失败项汇总 + 退出码
  - `README.md` 扩展"Linux 一键部署"章节：新增"配置 Origin 允许列表（重要）"+"部署后验证"+"宝塔面板部署（小白推荐）8 步详细操作"三个子章节
  - 本机自检全绿：deploy.ps1 ParseFile 0 errors / deploy.sh bash -n exit 0 / verify.sh bash -n exit 0 / compose.deploy.yml YAML OK / Rust+前端代码未改动沿用第 6 轮结果
  - 剩余：用户需在 Linux 服务器上真实跑 `./deploy.sh` + `./deploy/verify.sh --public-url`，把验证输出贴回来确认第 7 项完成
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 8 轮）**：用户说"继续"。第 7 项本机部分已完成（剩余需 Linux 真机），第 8 项 E2E 需启动 dev server + Chrome 本机难稳定验证，改为推进第 9 项"更新协议文档、威胁模型、运维手册、安全响应政策"（本机可做，符合用户"文档要详细"偏好）：
  - `docs/architecture.md` 重写：原内容过时（说 Redis 仅用于通知、S3 尚未接入）。新增 Durable storage / Redis（限流+Pub/Sub 双角色）/ Object storage（MinIO）/ Background cleanup（cleanup_once 纯函数）/ Request defences（Origin 校验+匿名限流+认证限流+body 大小限制）/ Limitations 章节
  - `docs/security/threat-model.md`：Adversaries 新增 CSRF 和滥用（批量注册/登录轰炸/恢复码爆破/用户名枚举）两类威胁；Security invariants 新增第 8-10 条（Origin allow-list / Redis 限流降级 / cleanup 后台任务）
  - `docs/security/data-flow.md` 重写：Message delivery 补充 directory 限流和 require_origin 中间件环节 + Redis Pub/Sub 跨实例事件；新增 Rate-limited endpoints 表（4 个端点+scope+limit+purpose）+ Background cleanup 章节 + Telemetry 章节
  - `SECURITY.md` 新增"Production deployment requirements"章节：ALLOWED_ORIGINS/REDIS_URL/DATABASE_URL/S3_ENDPOINT 必须设置 + 不暴露内部端口 + 反代必须转发 WebSocket 和 X-Forwarded-For + 引用 deploy/verify.sh
  - `docs/security/protocol-state.md` 和 `docs/security/key-lifecycle.md` 不需要更新（第 6 轮 Origin/限流不改变协议状态机或密钥生命周期）
  - 本机自检：纯 markdown 无代码可测试；已人工核对所有引用的环境变量名/端点/限制值与 main.rs 代码一致（ALLOWED_ORIGINS / onboard 5/h / challenge 10/m / recovery 5/h / directory 60/m / cleanup 类别）
  - 剩余：运维手册（docs/ops-runbook.md）尚未新建，需用户确认是否要新建（含监控/备份/升级/故障排查）；README 的"宝塔面板部署"章节已覆盖基本运维操作
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 9 轮）**：用户说"继续"。本机自检 7 轮累计修改无回归（cargo test 22 passed / npm test 3 passed）。做 PROJECT_CONTEXT 第 6 节第 19 项的 XSS/CSP/Trusted Types 审查（纯代码审查，不依赖外部环境）：
  - 第 6 轮代码自检：Origin 校验覆盖所有 20 个 POST/PUT/DELETE 端点 + WebSocket 手动校验；限流覆盖 4 个关键端点；authenticated/anonymous_rate_limit 在 Redis 故障时 fail closed（503），未配置时降级放行——边界正确无 bug
  - XSS 审查：无 `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`/`document.write`/`insertAdjacentHTML`/`outerHTML`；无 `href={}`/`src={}` 动态属性注入；无 `javascript:`/`data:` URL 风险；React 默认转义所有插值
  - CSP 审查：生产模式（preview/nginx）`script-src 'self' 'wasm-unsafe-eval'`（无 unsafe-inline）+ `object-src 'none'` + `base-uri 'none'` + `frame-ancestors 'none'`；开发模式（vite server）有 `'unsafe-inline'` 是 HMR 需要，合理
  - Trusted Types 审查：生产模式启用 `trusted-types covechat#pwa; require-trusted-types-for 'script'`；main.tsx 注册的 policy 只用于 createScriptURL("/sw.js")，无滥用；开发模式不启用 Trusted Types（HMR 需要）
  - URL 注入审查：用户名路径参数全用 `encodeURIComponent` 编码（api.ts 3 处）；WebSocket URL 基于自身 location，无注入
  - 结论：XSS/CSP/Trusted Types 防御健全，无需修改代码
  - 本机自检全绿（cargo test 22 passed / npm test 3 passed / 沿用第 6 轮结果，本轮纯审查无代码改动）
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 10 轮）**：用户说"ok"→ 提交推送 b1adb88（18 文件 +2151/-41 行）到 origin/main，CI 跑 6m21s 全绿成功（前端构建/前端测试/Rust fmt/Rust clippy/Rust 测试/WASM 编译全过）。用户说"继续"→ 推进第 8 项前端 E2E：
  - 用 subagent 新建 `apps/web/e2e/origin-rate-limit.mjs`（4 个测试用例覆盖第 6 轮 Origin 校验和限流）：
    - 测试 1：POST /api/v1/onboarding 带非法 Origin（https://evil.example.com）→ 403（require_origin 中间件）
    - 测试 2：开发模式无 Origin 放行 → 非 403 业务错误（与测试 1 互斥 skip）
    - 测试 3：连续 POST /api/v1/auth/challenges/{device_id} 11 次 → 第 11 次 429（anonymous_rate_limit 10/m）
    - 测试 4：WebSocket /api/v1/events/{device_id} 带非法 Origin → 403 不升级（events handler 手动校验）
  - 设计要点：用 Node 内置 fetch + http/https 模块（不依赖 Playwright/Chrome，本机无需启动浏览器）；WebSocket 测试手写 Upgrade 握手请求（WebSocket 客户端不允许自定义 Origin）；用环境变量 COVECHAT_ALLOWED_ORIGIN / COVECHAT_REDIS_URL 控制 skip（避免无 Redis/无 Origin 校验时假性失败）
  - `apps/web/package.json` 新增 `"test:e2e:origin": "node e2e/origin-rate-limit.mjs"` 脚本
  - 代码审查：确认 create_challenge 先限流再查 device（测试 3 的 404 预期正确）；vite.config.ts 的 /api 代理 changeOrigin:false 保留客户端 Origin 头（测试用 /api/v1/... 路径正确）
  - 本机自检全绿：node --check exit 0 / npm run typecheck 通过（package.json 改动未影响类型）
  - 剩余：需启动 dev server + 后端 + 可选 Redis 后跑 `npm run test:e2e:origin` 验证真实行为
  - 修改未提交，待用户确认后 git commit + push
- **2026-07-18（第 11 轮）**：用户说"ok"→ 本机启动 dev server 跑 E2E 验证第 10 轮的 origin-rate-limit.mjs：
  - 启动后端 cargo run（DATABASE_URL="" 走 ephemeral 模式）+ 前端 vite dev server（在 apps/web 目录，设 COVECHAT_WEB_HOST=127.0.0.1 走 IPv4）
  - 遇到的问题 1：旧 vite 进程（PID 20200）启动方式不对（命令行 `vite.js 127.0.0.1` 把 127.0.0.1 当 root 目录），导致监听 IPv6 ::1 且 /api 代理不工作（/api/health 返回 404）→ 杀掉重启在 apps/web 目录正确启动后解决
  - 遇到的问题 2：残留 covechat-api.exe 进程（PID 38164）占用 exe 文件导致 cargo run 编译失败（`failed to remove file ... 拒绝访问`）→ 杀掉残留进程后解决
  - 第一轮（开发模式，ALLOWED_ORIGINS 未设）：测试 2 pass（收到 422，开发模式放行到 handler，body 无效返回 422 Unprocessable Entity），测试 1/3/4 skip
  - 第二轮（ALLOWED_ORIGINS=http://127.0.0.1:5173，后端日志确认 "Origin enforcement enabled"）：测试 1 pass（收到 403，非法 Origin https://evil.example.com 被中间件拒绝），测试 4 pass（收到 403，WebSocket 非法 Origin 被拒绝升级），测试 2/3 skip
  - 合计 3/4 测试本机验证通过（测试 1/2/4），测试 3 需 Redis 才能跑（本机无 Redis）
  - 验证后清理：停止后端 + 前端 + 杀残留 covechat-api 进程，8080/5173 端口释放
  - 无代码改动（纯验证），无需提交
