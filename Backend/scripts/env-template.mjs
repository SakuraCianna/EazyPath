import { randomBytes } from 'node:crypto';

const replacedDefaults = new Map([
  ['APP_PUBLIC_URL', 'http://localhost:3000'],
  ['ADMIN_PUBLIC_URL', 'http://localhost'],
  ['CORS_ALLOWED_ORIGINS', 'http://localhost,http://localhost:4173,http://localhost:5173'],
  ['DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/eazypath'],
  ['POSTGRES_DB', 'eazypath'],
  ['POSTGRES_USER', 'eazypath'],
  ['REDIS_URL', 'redis://localhost:6379'],
  ['REDIS_DOCKER_URL', 'redis://redis:6379'],
  ['HTTP_PORT', '80'],
  ['ADMIN_BOOTSTRAP_USERNAME', 'sakura'],
  ['AGENT_MODEL', 'qwen3.7-plus'],
  ['VISION_MODEL', 'qwen3.6-flash'],
  ['ASR_MODEL', 'qwen3-asr-flash-realtime'],
  ['TTS_MODEL', 'qwen-audio-3.0-tts-plus'],
  ['TTS_VOICE', 'longanlingxin'],
  ['MEDIA_TEMP_DIR', './data/verification-temp'],
  ['MEDIA_UPLOAD_STAGING_DIR', './data/upload-staging'],
  ['MEDIA_EVIDENCE_DIR', './data/evidence'],
  ['MEDIA_MAX_IMAGE_BYTES', '10485760'],
  ['MEDIA_QUOTA_BYTES', '5368709120'],
  ['SSE_RESUME_WINDOW_SECONDS', '86400'],
  ['VOICE_WS_MAX_SESSION_SECONDS', '70'],
  ['LOG_LEVEL', 'info'],
  ['TRUST_PROXY', 'false'],
  ['PORT', '3000'],
  ['WORKER_CONCURRENCY', '4'],
]);

const retainedNames = new Set([
  'APP_ENV',
  'POSTGRES_PASSWORD',
  'DATABASE_DOCKER_URL',
  'AUTH_TOKEN_SECRET',
  'ADMIN_SESSION_SECRET',
  'DATA_ENCRYPTION_KEY_CURRENT_VERSION',
  'DATA_ENCRYPTION_KEYRING',
  'MEDIA_FINGERPRINT_KEY_CURRENT_VERSION',
  'MEDIA_FINGERPRINT_KEYRING',
  'ADMIN_BOOTSTRAP_PASSWORD_FILE',
  'ADMIN_BOOTSTRAP_PASSWORD',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_WORKSPACE_ID',
  'AMAP_WEB_SERVICE_KEY',
  'AMAP_WEB_SECURITY_KEY',
  'CTRIP_API_KEY',
  'MEITUAN_API_KEY',
  'DIDI_API_KEY',
  'RAILWAY_12306_API_KEY',
]);

const legacyNames = new Set(['AMAP_KEY', 'AMAP_SECURITY_KEY', 'AMAP_ANDROID_KEY']);

function randomSecret(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

function keepGeneratedSecret(current, name, fallback) {
  const value = current.get(name);
  return value === undefined || value.toLowerCase().includes('replace_with_') ? fallback : value;
}

export function buildEnvEntries(current) {
  const unknownNames = [...current.keys()].filter((name) =>
    !retainedNames.has(name) && !replacedDefaults.has(name) && !legacyNames.has(name),
  );
  if (unknownNames.length > 0) {
    throw new Error(`检测到不能静默删除的未知配置: ${unknownNames.join(', ')}`);
  }
  const customizedRemoved = [...replacedDefaults].filter(([name, defaultValue]) =>
    current.has(name) && current.get(name) !== defaultValue,
  );
  if (customizedRemoved.length > 0) {
    throw new Error(`检测到不能静默移除的自定义配置: ${customizedRemoved.map(([name]) => name).join(', ')}`);
  }

  const keep = (name, fallback, legacyName) => current.get(name) ?? (legacyName ? current.get(legacyName) : undefined) ?? fallback;
  const appEnv = keep('APP_ENV', 'development');
  const postgresPassword = keepGeneratedSecret(current, 'POSTGRES_PASSWORD', randomSecret(24));
  if (!/^[A-Za-z0-9_-]{16,}$/.test(postgresPassword)) {
    throw new Error('POSTGRES_PASSWORD 必须至少 16 位且仅使用字母、数字、下划线或连字符');
  }
  const databaseDockerUrl = `postgresql://eazypath:${encodeURIComponent(postgresPassword)}@postgres:5432/eazypath`;
  const developmentAdminPassword = appEnv === 'development'
    ? keepGeneratedSecret(current, 'ADMIN_BOOTSTRAP_PASSWORD', randomSecret(18))
    : '';

  return [
    ['应用运行环境, 本地开发使用 development', 'APP_ENV', appEnv, 'development'],
    ['PostgreSQL 初始密码, 至少 16 位且仅使用字母、数字、下划线或连字符', 'POSTGRES_PASSWORD', postgresPassword, 'replace_with_random_password'],
    ['Docker 内部 PostgreSQL 连接字符串, 由同步脚本生成', 'DATABASE_DOCKER_URL', databaseDockerUrl, 'postgresql://eazypath:replace_with_url_encoded_password@postgres:5432/eazypath'],
    ['匿名安装访问令牌签名密钥, 至少 32 个字符', 'AUTH_TOKEN_SECRET', keepGeneratedSecret(current, 'AUTH_TOKEN_SECRET', randomSecret()), 'replace_with_at_least_32_random_characters'],
    ['管理员会话签名密钥, 至少 32 个字符', 'ADMIN_SESSION_SECRET', keepGeneratedSecret(current, 'ADMIN_SESSION_SECRET', randomSecret()), 'replace_with_at_least_32_random_characters'],
    ['数据加密当前密钥版本', 'DATA_ENCRYPTION_KEY_CURRENT_VERSION', keep('DATA_ENCRYPTION_KEY_CURRENT_VERSION', 'v1'), 'v1'],
    ['数据加密密钥环, 格式为版本号加 Base64 密钥', 'DATA_ENCRYPTION_KEYRING', keepGeneratedSecret(current, 'DATA_ENCRYPTION_KEYRING', `v1:${randomBytes(32).toString('base64')}`), 'v1:replace_with_32_byte_base64_key'],
    ['媒体指纹当前密钥版本', 'MEDIA_FINGERPRINT_KEY_CURRENT_VERSION', keep('MEDIA_FINGERPRINT_KEY_CURRENT_VERSION', 'v1'), 'v1'],
    ['媒体指纹密钥环, 必须与数据加密密钥分离', 'MEDIA_FINGERPRINT_KEYRING', keepGeneratedSecret(current, 'MEDIA_FINGERPRINT_KEYRING', `v1:${randomBytes(32).toString('base64')}`), 'v1:replace_with_different_32_byte_base64_key'],
    ['初始管理员密码文件, staging 和 production 必须使用此项', 'ADMIN_BOOTSTRAP_PASSWORD_FILE', keep('ADMIN_BOOTSTRAP_PASSWORD_FILE', ''), ''],
    ['初始管理员本地开发密码, 非 development 环境自动留空', 'ADMIN_BOOTSTRAP_PASSWORD', developmentAdminPassword, 'replace_with_local_development_password'],
    ['阿里云百炼 API 密钥', 'DASHSCOPE_API_KEY', keep('DASHSCOPE_API_KEY', ''), 'replace_with_dashscope_api_key'],
    ['阿里云百炼北京地域 Workspace ID, 实时 ASR/TTS 启用前填写', 'DASHSCOPE_WORKSPACE_ID', keep('DASHSCOPE_WORKSPACE_ID', ''), ''],
    ['高德地图 Web 服务 API Key', 'AMAP_WEB_SERVICE_KEY', keep('AMAP_WEB_SERVICE_KEY', '', 'AMAP_KEY'), 'replace_with_amap_web_service_key'],
    ['高德地图 Web 端安全密钥, 后续 Web 地图能力启用时使用', 'AMAP_WEB_SECURITY_KEY', keep('AMAP_WEB_SECURITY_KEY', '', 'AMAP_SECURITY_KEY'), ''],
    ['携程开放平台凭据, 获得正式授权后启用', 'CTRIP_API_KEY', keep('CTRIP_API_KEY', ''), ''],
    ['美团开放平台凭据, 获得正式授权后启用', 'MEITUAN_API_KEY', keep('MEITUAN_API_KEY', ''), ''],
    ['滴滴开放平台凭据, 获得正式授权后启用', 'DIDI_API_KEY', keep('DIDI_API_KEY', ''), ''],
    ['铁路服务凭据, 获得正式授权后启用', 'RAILWAY_12306_API_KEY', keep('RAILWAY_12306_API_KEY', ''), ''],
  ];
}

export function upsertGradleProperty(content, name, value) {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith(`${name}=`));
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}${name}=${value}\n`;
}
