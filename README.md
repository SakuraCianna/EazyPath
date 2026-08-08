# EazyPath

EazyPath 是面向轮椅和行动不便用户的真实数据无障碍出行链 MVP。项目不会用 Mock 数据填补未知信息：没有可靠证据时，客户端和管理端会明确显示“未知”或“需要复核”。

## 当前工程状态

本次重写已经替换 Demo 数据链路并建立可继续开发的真实后端、Android 和管理端基础，但尚未达到 PRD 全部 P0 的发布验收条件。

| 模块 | 当前状态 | 尚未完成 |
| :--- | :--- | :--- |
| 匿名安装账户与偏好 | 已接真实 API，Keystore 签名和加密令牌存储 | 并发认证安全测试、可选手机号绑定 P1 |
| 文字 Agent 与 SSE | 已接 Qwen、BullMQ、真实高德 POI、PostgreSQL 事件恢复 | 完整任务补充/取消端侧交互、状态机压力测试 |
| AI 图片验真 | 已接 VLM、临时 tmpfs、成功/最终失败删除 | AI 验真图片的独立端侧脱敏编辑复用 |
| 社区证据 | Android 已支持真实地点搜索、数据库字段定义动态表单、端侧脱敏与分片续传；后端已有字段类型校验、一次性位置证明、撤回、审核、30 天申诉和社区复核 | Android 瞬时位置证明接入、社区治理自动派单与异常场景集成测试 |
| 管理端 | 后端已有安全登录、会话/CSRF、RBAC、证据与 AI 验真审核、申诉处理、乐观锁、审计和受控脱敏媒体读取 | React 管理端按新审核 API 重构、完整可访问性交互和 UI 自动化测试 |
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

后端配置位于 `Backend/.env`，模板位于 `Backend/.env.example`。日常文件只保留密钥、管理员引导方式、Docker 数据库密码和未来平台凭据；模型名、内部服务地址、目录、限额、端口与并发使用代码或 Compose 的安全默认值。同步脚本会保留模板继续管理的已有值、迁移旧变量名，并为缺失的本地密钥生成随机值：

```powershell
Set-Location .\Backend
node .\scripts\sync-env.mjs
```

当前模板为 18 项。携程、美团、滴滴、12306 和高德 Web 安全密钥即使暂时为空也会保留，获得正式授权或启用对应能力后直接填写。`DATABASE_DOCKER_URL` 由同步脚本根据 URL 编码后的 PostgreSQL 密码生成，不要手工拼接。首次部署前至少检查：

- `DASHSCOPE_API_KEY`
- `AMAP_WEB_SERVICE_KEY`
- `AUTH_TOKEN_SECRET`、`ADMIN_SESSION_SECRET` 和两个独立 keyring
- Docker 测试部署的 `POSTGRES_PASSWORD`，至少 16 位且仅使用字母、数字、下划线或连字符，避免 Compose 二次插值
- 开发环境的 `ADMIN_BOOTSTRAP_PASSWORD`，初始用户名默认是 `sakura`

staging/production 必须通过部署环境显式提供 `DATABASE_URL` 和 `REDIS_URL`，禁止回退到本地默认地址；同时禁止使用 `ADMIN_BOOTSTRAP_PASSWORD`，应通过 `ADMIN_BOOTSTRAP_PASSWORD_FILE` 提供一次性 Secret。管理员写入数据库的是 Argon2id 哈希，引导脚本幂等执行且不会打印密码。

同步脚本只会移除仍等于旧默认值的冗余字段；如果发现非默认的公开地址、CORS、模型、目录、限额或并发覆盖，会中止并列出字段名，避免静默丢失自定义配置。应先把这些覆盖迁移到服务器部署环境，再重新同步。若从 `.env.example` 复制后执行同步，脚本会替换密码、签名密钥和 keyring 的示例占位值；第三方服务 Key 不会伪造，未填写时启动校验会明确拒绝。

Android Key 不进入后端 `.env`。同步脚本发现旧 `.env` 中存在非空 `AMAP_ANDROID_KEY` 时，会把它迁移到被 Git 忽略的 `App/local.properties`，并保留 Android Studio 已写入的 SDK 路径；没有旧值时，需要参考 `App/local.properties.example` 把字段追加到本机 `local.properties`，或通过 CI Secret 设置 `ORG_GRADLE_PROJECT_AMAP_ANDROID_KEY`，由 Gradle 官方项目属性机制注入：

```properties
AMAP_ANDROID_KEY=替换为绑定包名和签名的AndroidKey
EAZYPATH_API_BASE_URL=https://api.example.com/
```

## 管理员认证与 RBAC

- `POST /api/v1/admin/auth/login`：创建随机不透明会话和 CSRF 令牌，失败响应不区分用户名是否存在；Redis 在 Argon2id 前执行来源/全局限流和并发租约，Nginx 提供第二层来源限流
- `GET /api/v1/admin/auth/me`：读取当前管理员、角色和权限
- `POST /api/v1/admin/auth/csrf`：浏览器刷新后轮换并恢复 CSRF 令牌
- `POST /api/v1/admin/auth/change-password`：验证当前密码，修改后撤销全部会话
- `POST /api/v1/admin/auth/logout` 与 `/logout-all`：撤销当前或全部会话
- `/api/v1/admin/admin-users/*` 与 `/roles/*`：创建管理员、停用/换角色、撤销会话和管理权限字典

除登录、身份读取和 CSRF 恢复外，管理端写请求必须同时携带 HttpOnly Session Cookie 和 `X-CSRF-Token`。管理员停用、角色变化或角色权限变化会立即撤销受影响会话；系统始终保留至少一个活跃超级管理员。角色与管理员写操作会在事务内重新读取操作者角色，普通管理员只能授予自身权限子集，`super_admin` 和 `*` 只能由超级管理员授予。连续失败仍记录账户锁定状态，但正确密码可立即恢复，避免匿名攻击者利用默认用户名持续阻断合法管理员。正式管理员密码至少 12 位，拒绝常见密码、包含用户名以及缺少字母或数字的密码。

## 证据审核与申诉

- `GET /api/v1/admin/reviews/observations` 与 `/:id`：按状态读取审核队列、结构化字段、粗粒度位置证明、脱敏媒体、用户反馈和审计历史
- `POST /api/v1/admin/reviews/observations/:id/decision`：批准、驳回或要求补充；使用 `expected_version` 防止多个管理员覆盖结论
- `GET /api/v1/admin/reviews/appeals` 与 `POST /appeals/:id/decision`：处理用户申诉，可重新进入待审、驳回或要求补充；写入请求必须回传 `expected_observation_version` 和 `expected_appeal_updated_at`
- `GET /api/v1/admin/reviews/verifications` 与 `POST /verifications/:id/decision`：人工确认或标记 AI 验真结果，使用更新时间作乐观锁
- `GET /api/v1/admin/reviews/media/:id/content`：只读取已关联、已确认脱敏且未删除的持久证据；响应禁止缓存，每次成功读取记录审计
- `GET /api/v1/observations/:id/moderation`、`POST /:id/appeals` 与 `POST /:id/supplements`：匿名安装账户只能查看、申诉并响应自己观测的活动补充请求；补充可包含纠正后的结构化值和新脱敏图片，并必须回传 `expected_observation_version` 与 `expected_feedback_updated_at`

社区观测初始为 `pending/U`，管理员批准最多提升为 `C`，不会自动产生官方 `A` 级证据。驳回图片保留至 30 天申诉期结束后再由清理任务删除；临近截止提交申诉或管理员要求补充时，系统提供 7 天有界响应窗口并把明确截止时间返回给客户端，整个申诉的媒体保留硬上限不超过原 30 天窗口结束后 7 天，重复要求补充也不能继续延长。每分钟维护任务会自动结案超时反馈并恢复媒体清理；文件物理删除成功时同步清除 HMAC 指纹与密钥版本，仅保留 `deleted_at` 等最小审计元数据，删除失败不会伪装成功。匿名账户删除会先进入 `deleting` 状态并立即阻止普通接口、撤销会话，再清理上传分片、媒体文件与指纹、反馈正文和注册挑战；社区观测同步停止公开，历史审计主体去标识化。同步清理失败时，每分钟维护任务继续重试，不依赖用户保持登录。重新受理或用户按时补充后回到待审核状态。用户撤回则立即标记过期。审核、媒体生命周期、贡献计数和审计写入保持在同一事务内，活动申诉必须从申诉队列处理。

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

项目使用 Drizzle Kit + Drizzle Migrator 管理 PostgreSQL 迁移，作用相当于 Java 项目中的 Flyway。当前仍在开发阶段，`Backend/drizzle/0000_baseline.sql` 是唯一基线 SQL，包含 27 张正式表、PostGIS 扩展和初始化字典；旧 Demo 表已从迁移历史移除。

- `src/db/schema.ts` 是表结构代码事实源
- `drizzle.config.ts` 配置 schema、PostgreSQL dialect 和迁移目录
- 当前开发阶段修改结构时直接同步 `src/db/schema.ts` 和 `0000_baseline.sql`，不得生成第二个 SQL；进入正式发布后再改用增量迁移
- `npm run db:check` 检查 snapshot、journal 与 SQL 历史一致性
- `npm run db:migrate` 使用 `drizzle-orm/postgres-js/migrator` 按 journal 执行未应用迁移，并记录到 `drizzle.__drizzle_migrations`

开发期若某个本地数据库已经应用过旧版本 `0000_baseline.sql`，再次运行 `db:migrate` 不会把同一基线当作增量升级。应先备份需要保留的数据，再由维护者明确重建可丢弃的开发数据库；进入正式发布后禁止改写已发布基线，改用新的增量迁移。

容器入口会自动执行 Drizzle 迁移和幂等管理员引导。手工执行前必须已经完成后端构建：

```powershell
Set-Location .\Backend
npm run build
npm run db:check
npm run db:migrate
npm run admin:bootstrap
```

不要使用 `db:push` 直接修改生产数据库。正式迁移前应备份 PostgreSQL 数据卷并审阅 `Backend/drizzle/` 中的 SQL。
