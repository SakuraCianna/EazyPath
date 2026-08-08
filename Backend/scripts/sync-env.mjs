import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const envPath = new URL('../.env', import.meta.url);
const examplePath = new URL('../.env.example', import.meta.url);

function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function randomSecret(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

const current = parseEnv(await readFile(envPath, 'utf8').catch(() => ''));
const keep = (name, fallback, legacyName) => current.get(name) ?? (legacyName ? current.get(legacyName) : undefined) ?? fallback;
const postgresPassword = keep('POSTGRES_PASSWORD', randomSecret(24));

const entries = [
  ['应用运行环境, 本地开发使用 development', 'APP_ENV', keep('APP_ENV', 'development'), 'development'],
  ['后端公开地址, 本地直连端口为 3000', 'APP_PUBLIC_URL', keep('APP_PUBLIC_URL', 'http://localhost:3000'), 'http://localhost:3000'],
  ['管理端公开地址, Docker 默认由 Nginx 提供', 'ADMIN_PUBLIC_URL', keep('ADMIN_PUBLIC_URL', 'http://localhost'), 'http://localhost'],
  ['允许跨域的管理端来源, 多个来源使用英文逗号分隔', 'CORS_ALLOWED_ORIGINS', keep('CORS_ALLOWED_ORIGINS', 'http://localhost,http://localhost:4173,http://localhost:5173'), 'http://localhost,http://localhost:4173'],
  ['本地开发 PostgreSQL 连接字符串', 'DATABASE_URL', keep('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/eazypath'), 'postgresql://postgres:replace_with_password@localhost:5432/eazypath'],
  ['Docker 内部 PostgreSQL 连接字符串', 'DATABASE_DOCKER_URL', keep('DATABASE_DOCKER_URL', `postgresql://eazypath:${postgresPassword}@postgres:5432/eazypath`), 'postgresql://eazypath:replace_with_password@postgres:5432/eazypath'],
  ['PostgreSQL 初始数据库名', 'POSTGRES_DB', keep('POSTGRES_DB', 'eazypath'), 'eazypath'],
  ['PostgreSQL 初始用户名', 'POSTGRES_USER', keep('POSTGRES_USER', 'eazypath'), 'eazypath'],
  ['PostgreSQL 初始密码, 必须使用随机强密码', 'POSTGRES_PASSWORD', postgresPassword, 'replace_with_random_password'],
  ['本地开发 Redis 连接字符串', 'REDIS_URL', keep('REDIS_URL', 'redis://localhost:6379'), 'redis://localhost:6379'],
  ['Docker 内部 Redis 连接字符串', 'REDIS_DOCKER_URL', keep('REDIS_DOCKER_URL', 'redis://redis:6379'), 'redis://redis:6379'],
  ['Nginx 对外 HTTP 端口', 'HTTP_PORT', keep('HTTP_PORT', '80'), '80'],
  ['匿名安装访问令牌签名密钥, 至少 32 个字符', 'AUTH_TOKEN_SECRET', keep('AUTH_TOKEN_SECRET', randomSecret()), 'replace_with_at_least_32_random_characters'],
  ['管理员会话签名密钥, 至少 32 个字符', 'ADMIN_SESSION_SECRET', keep('ADMIN_SESSION_SECRET', randomSecret()), 'replace_with_at_least_32_random_characters'],
  ['数据加密当前密钥版本', 'DATA_ENCRYPTION_KEY_CURRENT_VERSION', keep('DATA_ENCRYPTION_KEY_CURRENT_VERSION', 'v1'), 'v1'],
  ['数据加密密钥环, 格式为版本号加 Base64 密钥', 'DATA_ENCRYPTION_KEYRING', keep('DATA_ENCRYPTION_KEYRING', `v1:${randomBytes(32).toString('base64')}`), 'v1:replace_with_32_byte_base64_key'],
  ['媒体指纹当前密钥版本', 'MEDIA_FINGERPRINT_KEY_CURRENT_VERSION', keep('MEDIA_FINGERPRINT_KEY_CURRENT_VERSION', 'v1'), 'v1'],
  ['媒体指纹密钥环, 必须与数据加密密钥分离', 'MEDIA_FINGERPRINT_KEYRING', keep('MEDIA_FINGERPRINT_KEYRING', `v1:${randomBytes(32).toString('base64')}`), 'v1:replace_with_different_32_byte_base64_key'],
  ['初始管理员用户名', 'ADMIN_BOOTSTRAP_USERNAME', keep('ADMIN_BOOTSTRAP_USERNAME', 'sakura'), 'sakura'],
  ['初始管理员密码文件, staging 和 production 必须使用此项', 'ADMIN_BOOTSTRAP_PASSWORD_FILE', keep('ADMIN_BOOTSTRAP_PASSWORD_FILE', ''), ''],
  ['初始管理员本地开发密码, 非 development 环境必须留空', 'ADMIN_BOOTSTRAP_PASSWORD', keep('ADMIN_BOOTSTRAP_PASSWORD', randomSecret(18)), 'replace_with_local_development_password'],
  ['阿里云百炼 API 密钥', 'DASHSCOPE_API_KEY', keep('DASHSCOPE_API_KEY', '', 'DASHSCOPE_API_KEY'), 'replace_with_dashscope_api_key'],
  ['Agent 意图解析与任务规划模型', 'AGENT_MODEL', keep('AGENT_MODEL', 'qwen3.7-plus'), 'qwen3.7-plus'],
  ['无障碍图片验真视觉模型', 'VISION_MODEL', keep('VISION_MODEL', 'qwen3.6-flash'), 'qwen3.6-flash'],
  ['实时语音识别模型', 'ASR_MODEL', keep('ASR_MODEL', 'qwen3-asr-flash-realtime'), 'qwen3-asr-flash-realtime'],
  ['语音合成模型', 'TTS_MODEL', keep('TTS_MODEL', 'qwen-audio-3.0-tts-plus'), 'qwen-audio-3.0-tts-plus'],
  ['高德地图 Web 服务 API Key', 'AMAP_WEB_SERVICE_KEY', keep('AMAP_WEB_SERVICE_KEY', '', 'AMAP_KEY'), 'replace_with_amap_web_service_key'],
  ['高德地图 Web 端安全密钥, 暂不发送到客户端', 'AMAP_WEB_SECURITY_KEY', keep('AMAP_WEB_SECURITY_KEY', '', 'AMAP_SECURITY_KEY'), 'replace_with_amap_web_security_key'],
  ['高德地图 Android SDK Key, Android 构建时还需写入 Gradle 属性', 'AMAP_ANDROID_KEY', keep('AMAP_ANDROID_KEY', ''), 'replace_with_amap_android_key'],
  ['携程开放平台凭据, 未获正式授权前不启用代办', 'CTRIP_API_KEY', keep('CTRIP_API_KEY', ''), 'replace_with_authorized_ctrip_key'],
  ['美团开放平台凭据, 未获正式授权前不启用代办', 'MEITUAN_API_KEY', keep('MEITUAN_API_KEY', ''), 'replace_with_authorized_meituan_key'],
  ['滴滴开放平台凭据, 未获正式授权前不启用代叫车', 'DIDI_API_KEY', keep('DIDI_API_KEY', ''), 'replace_with_authorized_didi_key'],
  ['铁路服务凭据, 仅在取得官方授权后使用', 'RAILWAY_12306_API_KEY', keep('RAILWAY_12306_API_KEY', ''), 'replace_with_authorized_railway_key'],
  ['AI 验真临时图片目录, 必须使用非持久存储', 'MEDIA_TEMP_DIR', keep('MEDIA_TEMP_DIR', './data/verification-temp'), './data/verification-temp'],
  ['社区图片分片暂存目录', 'MEDIA_UPLOAD_STAGING_DIR', keep('MEDIA_UPLOAD_STAGING_DIR', './data/upload-staging'), './data/upload-staging'],
  ['审核通过的社区证据目录', 'MEDIA_EVIDENCE_DIR', keep('MEDIA_EVIDENCE_DIR', './data/evidence'), './data/evidence'],
  ['单张图片最大字节数', 'MEDIA_MAX_IMAGE_BYTES', keep('MEDIA_MAX_IMAGE_BYTES', '10485760'), '10485760'],
  ['本地媒体总配额字节数', 'MEDIA_QUOTA_BYTES', keep('MEDIA_QUOTA_BYTES', '5368709120'), '5368709120'],
  ['SSE 事件可恢复窗口秒数', 'SSE_RESUME_WINDOW_SECONDS', keep('SSE_RESUME_WINDOW_SECONDS', '86400'), '86400'],
  ['语音 WebSocket 单会话最长秒数', 'VOICE_WS_MAX_SESSION_SECONDS', keep('VOICE_WS_MAX_SESSION_SECONDS', '70'), '70'],
  ['服务端日志级别', 'LOG_LEVEL', keep('LOG_LEVEL', 'info'), 'info'],
  ['是否信任反向代理头, Docker 部署使用 true', 'TRUST_PROXY', keep('TRUST_PROXY', 'false'), 'false'],
  ['后端监听端口', 'PORT', keep('PORT', '3000'), '3000'],
  ['BullMQ Worker 并发任务数', 'WORKER_CONCURRENCY', keep('WORKER_CONCURRENCY', '4'), '4'],
];

function render(valueIndex) {
  return `${entries.map(([comment, name, value, example]) => `# ${comment}\n${name}=${valueIndex === 2 ? value : example}`).join('\n\n')}\n`;
}

await writeFile(envPath, render(2), { encoding: 'utf8', mode: 0o600 });
await writeFile(examplePath, render(3), 'utf8');
console.info(`已同步 ${entries.length} 个环境变量, 未输出任何配置值`);
