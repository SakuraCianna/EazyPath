# EazyPath

EazyPath 是面向轮椅和行动不便用户的真实数据无障碍出行链 MVP。项目不会用 Mock 数据填补未知信息：没有可靠证据时，客户端和管理端会明确显示“未知”或“需要复核”。

## 当前工程状态

本次重写已经替换 Demo 数据链路并建立可继续开发的真实后端、Android 和管理端基础，但尚未达到 PRD 全部 P0 的发布验收条件。

| 模块 | 当前状态 | 尚未完成 |
| :--- | :--- | :--- |
| 匿名安装账户与偏好 | 已接真实 API，Keystore 签名和加密令牌存储 | 并发认证安全测试、可选手机号绑定 P1 |
| 文字 Agent 与 SSE | 已接 Qwen、BullMQ、真实高德 POI、PostgreSQL 事件恢复 | 完整任务补充/取消端侧交互、状态机压力测试 |
| AI 图片验真 | 已接 VLM、临时 tmpfs、成功/最终失败删除 | AI 验真图片的独立端侧脱敏编辑复用 |
| 社区证据 | Android 已支持真实地点搜索、数据库字段定义动态表单、端侧脱敏与分片续传，并已接入复核任务绑定的一次性高德定位证明与可选脱敏图片；后端已有字段类型校验、撤回、审核、30 天申诉、加权共识和到期复核派单 | 高频/非到期冲突自动派单与真实数据库并发测试 |
| 管理端 | React 已接安全会话恢复、权限导航、现场证据/申诉/AI 验真/社区冲突队列、受控媒体读取、地点治理、管理员与角色管理、账号安全，并统一采用响应式 Material 3 Expressive 设计 | 浏览器 UI 自动化测试、任务/媒体/审计等其余运营页的专用操作 |
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

React 审核工作台默认读取真实待办队列，不生成占位记录。现场证据、申诉和 AI 验真决定会回传服务端版本或更新时间作为乐观锁；脱敏图片只有管理员主动点击且具备 `media.read` 权限时才读取，每次成功读取由后端记录审计。管理端刷新后通过 HttpOnly Cookie 恢复身份并轮换 CSRF，浏览器只在会话存储中保留 CSRF 令牌，不持久化管理员身份或会话令牌；同源标签页通过 BroadcastChannel 同步令牌并用 Web Locks 串行恢复，令牌失配时只强制轮换和重试一次。

## 地点主数据治理

管理端地点页使用真实 PostgreSQL 地点、观测和设施计数，支持服务端分页/搜索、新增、完整编辑、软停用、重新启用和重复地点合并；合并目标通过独立的启用地点搜索接口选择，不受当前列表页大小限制。所有写入必须填写理由并回传 `updated_at` 乐观锁；停用不会删除历史证据，已经作为其他记录 canonical 目标的地点不能停用。

合并时服务端按 UUID 固定顺序锁定来源和目标，在同一事务中把地点单元、设施、现场观测、AI 验真、社区复核任务和位置证明迁移到启用中的 canonical 地点，并把既有别名一起重定向，避免产生多级 canonical 链。来源记录保留为只读 `merged` 别名并记录审计，不做物理删除。高德搜索、地点详情、现场观测、位置证明和 AI 验真会把旧 merged ID 解析到 active canonical 地点；写入在事务内锁定 canonical 行，状态并发变化返回 `409`，disabled 地点不会继续进入公开数据链。

管理员编辑高德来源地点后会记录 `admin_override_at`，后续高德查询仍刷新 `source_updated_at`，但不会静默覆盖人工核对后的名称、类别、坐标和地址。公开地点详情只返回审核通过且未撤回的最新 200 条证据，并通过 `evidence_timeline_has_more` 标记是否仍有历史记录。相关 `place_id` 和反向别名查询均有索引，数据库仍只维护 `Backend/drizzle/0000_baseline.sql` 一个开发期基线。管理端真实高德地图画布仍待 Web JS Key 和安全密钥配置完成后接入，当前页不伪造地图数据。

## 社区复核与冲突处置

同一安装账户在同一复核轮次通过数据库唯一约束只保留最后一票。提交时服务端在同一事务内锁定活动账户和复核任务，原子认领一次性位置证明和 `pending_link` 脱敏图片、覆盖本轮投票、重新计算版本化共识并更新关联观测；并发投票不会留下“位置证明或图片已消费但票未写入”的中间状态。复核补图从关联时起设置 180 天硬删除期限，覆盖或移除图片时，无其他观测/投票引用的旧图立即进入清理；旧社区图片的保留期不会因复核成功自动延长。达到规格门槛且方向为 `present` 时，关联观测升为 B 级并刷新 90 天；方向为 `absent` 或达到门槛但冲突时，原始观测仍作为历史记录保留，但降为 U 级并退出当前推荐。匿名账户进入删除状态时，其票立即暂停并触发剩余票重算，不会让已删除账户继续支撑 B 级结果。

Android 复核页不会展示其他用户的当前票，原证据提交者也无法查看或参与自己的独立复核。列表使用 `created_at + id` 稳定游标分页，不会因固定前 50 条导致旧任务永久不可达；作答前只展示不含安装标识和媒体路径的历史结构化证据，并明确过期/冲突风险。用户可以选择“存在 / 不存在 / 不确定”，也可以拒绝位置和图片后按 0.5 基础权重提交。

用户主动阅读高德第三方处理者、信息类型、用途和官方隐私政策链接并同意后，App 才会初始化高德定位 SDK，请求一次前台位置，并显式强制定位协议为 HTTPS；25 秒无回调会停止等待。精确坐标只在内存中用于一次校验请求，服务端按该复核任务的半径计算后只保存通过结果、粗粒度距离区间、校验时间和 15 分钟有效证明。位置证明按安装账户、HMAC 短期网络来源和全局窗口使用 Redis 原子限流，过期行由每分钟维护任务删除。可选图片先在设备端检测人脸和敏感文字，用户可补画实色遮挡、预览并确认；发布前还必须确认普通用户/管理员查看范围、180 天保存上限和撤回方式，再进行分片上传。

每次复核写入携带客户端提交 UUID。移动网络响应丢失时，App 保留并复用同一 UUID 查询或重试；服务端会在地点/任务终态和一次性证明检查前返回该 UUID 已落库的原结果，不会重复消费证明或图片，也不会把本轮旧票误认为本次提交成功。提交进行中页面会阻止误返回；服务端明确拒绝后才允许生成新的提交 UUID。原社区观测撤回会按统一锁序取消活动复核任务，停用地点、未批准或已撤回证据在列表和提交事务中均被双重拦截。

管理端 `/community` 使用真实分页 API 展示聚合权重、规则版本、匿名投票的图片/位置证明完整度和关联证据状态，不返回安装 GUID、安装账户 ID、精确位置或旧快照中的逐票标识。具有 `media.read` 权限时可显式读取脱敏复核图片；图片响应禁止缓存并逐次记录查看审计，页面离开时回收 Blob URL。具有 `reviews.decide` 权限的管理员可以填写理由并用 `updated_at` 乐观锁执行三类操作：保留旧轮次并重新发起空白轮次、驳回该轮并保持关联事实未知、作废错误或重复任务；管理员不能凭该页面把社区证据认证为 A 级。写操作记录审计，Redis 对单安装账户、HMAC 短期网络风险来源和全局复核写入做原子短窗口限流；同轮跨账户重复媒体指纹或短时来源安装实例异常增长会暂停相关新票计权。网络风险指纹只存在于 Redis 短窗口内，审计仅保留风险类型，不保存原始 IP 或来源指纹。保护不可用时停止计票并返回可重试错误。共识规则由 20 组固定样例覆盖；真实 PostgreSQL 并发事务测试仍列入后续容器化集成测试。

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
