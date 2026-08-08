# EazyPath

EazyPath 是面向轮椅和行动不便用户的真实数据无障碍出行链 MVP。项目不会用 Mock 数据填补未知信息：没有可靠证据时，客户端和管理端会明确显示“未知”或“需要复核”。

## 当前工程状态

本次重写已经替换 Demo 数据链路并建立可继续开发的真实后端、Android 和管理端基础，但尚未达到 PRD 全部 P0 的发布验收条件。

| 模块 | 当前状态 | 尚未完成 |
| :--- | :--- | :--- |
| 匿名安装账户与偏好 | 已接真实 API，Keystore 签名和加密令牌存储 | 并发认证安全测试、可选手机号绑定 P1 |
| 文字 Agent 与 SSE | 已接 Qwen、BullMQ、真实高德 POI、PostgreSQL 事件恢复 | 完整任务补充/取消端侧交互、状态机压力测试 |
| AI 图片验真 | 已接 VLM、临时 tmpfs、成功/最终失败删除 | Android 端自动人脸/车牌/文字检测与手工马赛克 |
| 社区证据 | 后端已有分片上传、位置证明、观测、撤回、复核与共识 | Android 现场提交 UI、管理端受控原图审核闭环 |
| 管理端 | 已有登录、RBAC 门禁、真实列表、基础新增/审核/平台配置 | 冲突结案、会话撤销、媒体操作等完整运营动作和 UI 自动化测试 |
| 语音 | Android 系统语音识别与 TTS 可用 | Qwen 实时 ASR/TTS WebSocket 和 PCM/Opus 流式采集 |
| 部署 | Node 24、PG 18/PostGIS、Redis 8/BullMQ、Nginx Compose 已配置 | 当前 Compose 仅供受控测试；生产 TLS/WSS 证书与外部入口尚未配置 |

- `App/`：Android 29+ 原生 App，Jetpack Compose + Material 3、高德地图、匿名安装账户、文字任务链、图片验真、社区复核、语音输入和结果播报
- `Backend/`：Node.js 24 + Hono + PostgreSQL 18/PostGIS + BullMQ/Redis 8，提供匿名认证、Agent、SSE、媒体、社区、隐私和管理 API
- `Admin/`：React 19 + Vite 管理端，包含看板、地点、证据、复核、任务、平台、媒体、管理员与审计模块
- `deploy/`：Nginx 静态资源、API、SSE 和 WebSocket 反向代理配置
- `跨平台无障碍出行链自动化Agent中枢需求文档.md`：产品、接口、数据、安全和验收规格

## 真实能力边界

- 高德 Web 服务用于真实 POI 查询，Android SDK 用于地图展示和普通路线入口。高德当前没有轮椅路线规划模式，因此 EazyPath 不会把普通步行路线标成无障碍路线
- 酒店、餐饮、打车和铁路在没有正式业务接口授权时只提供安全 DeepLink、官方网页或复制兜底，不声称已经完成预订、叫车或重点旅客预约
- 无障碍属性来自经审核的结构化证据；高德 POI 本身不等于轮椅友好
- AI 验真原图进入非持久临时目录，处理完成立即删除，异常残留由 BullMQ 周期任务在 10 分钟内清理
- 社区证据只保存用户确认后的脱敏图片，支持审核、过期、冲突和其他用户复核
- Android 当前使用系统语音识别和 TTS 完成可用的语音输入与播报；PRD 中的 Qwen 实时 ASR/TTS WebSocket 网关尚未接通

## 配置

后端配置位于 `Backend/.env`，模板位于 `Backend/.env.example`。同步脚本会保留已有值、迁移旧变量名，并为缺失的本地密钥生成随机值：

```powershell
Set-Location .\Backend
node .\scripts\sync-env.mjs
```

首次部署前至少检查以下配置：

- `DASHSCOPE_API_KEY`
- `AMAP_WEB_SERVICE_KEY`
- `DATABASE_URL` 与 `DATABASE_DOCKER_URL`
- `AUTH_TOKEN_SECRET`、`ADMIN_SESSION_SECRET` 和两个独立 keyring
- `ADMIN_BOOTSTRAP_USERNAME` 与开发环境的 `ADMIN_BOOTSTRAP_PASSWORD`

staging/production 禁止使用 `ADMIN_BOOTSTRAP_PASSWORD`，应通过 `ADMIN_BOOTSTRAP_PASSWORD_FILE` 提供一次性 Secret。管理员写入数据库的是 Argon2id 哈希，引导脚本幂等执行且不会打印密码。

Android 构建参数放在未提交的 Gradle 用户配置或 CI Secret 中：

```properties
AMAP_ANDROID_KEY=替换为绑定包名和签名的AndroidKey
EAZYPATH_API_BASE_URL=https://api.example.com/
```

## 不启动服务的检查

安装依赖后，可以只做静态检查和构建：

```powershell
Set-Location .\Backend
npm ci
npm run test
npm run typecheck
npm run build

Set-Location ..\Admin
npm ci
npm run typecheck
npm run build

Set-Location ..\App
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

这些命令不会启动 API、Worker、管理端或 Android 应用。

## Docker Compose 测试部署

先校验最终 Compose 配置，不创建容器：

```powershell
docker compose --env-file .\Backend\.env config --quiet
```

需要在受控测试服务器实际部署时再执行：

```powershell
docker compose --env-file .\Backend\.env up -d --build
```

部署包含：

- Node.js 24 单容器内的 Hono API 与 BullMQ Worker
- Redis 8 AOF，`maxmemory-policy=noeviction`
- PostgreSQL 18 + PostGIS 3.6，数据卷挂载到 PG 18 的 `/var/lib/postgresql`
- Nginx 1.29，托管管理端并代理 API/SSE/WS
- AI 临时图片 tmpfs、上传暂存卷和社区证据卷，三者物理隔离

API 与 Worker 暂时同容器是单机 MVP 的隐私约束：两者需要共享非持久 tmpfs，避免把 AI 原图放入可恢复的命名卷。未来拆分 Worker 时必须改用同主机内存文件服务或其他不可持久化的受控传输方案。

当前 Nginx 配置只监听 HTTP 80，适合本地或上游已有 TLS 终止的受控测试。公网生产部署必须先增加受信任的 HTTPS/WSS 终止、HTTP 到 HTTPS 跳转和证书轮换，并验证 `X-Forwarded-Proto` 信任边界；否则不要把 Compose 暴露到公网。

## 数据库迁移

项目使用 Drizzle Kit + Drizzle Migrator 管理 PostgreSQL 迁移，作用相当于 Java 项目中的 Flyway。当前仍在开发阶段，`Backend/drizzle/0000_baseline.sql` 是唯一基线 SQL，包含 26 张正式表、PostGIS 扩展和初始化字典；旧 Demo 表已从迁移历史移除。

- `src/db/schema.ts` 是表结构代码事实源
- `drizzle.config.ts` 配置 schema、PostgreSQL dialect 和迁移目录
- `npm run db:generate` 在后续结构变更时生成新的增量迁移
- `npm run db:check` 检查 snapshot、journal 与 SQL 历史一致性
- `npm run db:migrate` 使用 `drizzle-orm/postgres-js/migrator` 按 journal 执行未应用迁移，并记录到 `drizzle.__drizzle_migrations`

容器入口会自动执行 Drizzle 迁移和幂等管理员引导。手工执行前必须已经完成后端构建：

```powershell
Set-Location .\Backend
npm run build
npm run db:check
npm run db:migrate
npm run admin:bootstrap
```

不要使用 `db:push` 直接修改生产数据库。正式迁移前应备份 PostgreSQL 数据卷并审阅 `Backend/drizzle/` 中的 SQL。
