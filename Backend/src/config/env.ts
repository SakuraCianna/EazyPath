import path from 'node:path';
import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalString = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().optional(),
);
const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_PUBLIC_URL: z.url().default('http://localhost:3000'),
  ADMIN_PUBLIC_URL: z.url().default('http://localhost'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost,http://localhost:4173,http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@localhost:5432/eazypath'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  AUTH_TOKEN_SECRET: z.string().min(32),
  ADMIN_SESSION_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY_CURRENT_VERSION: z.string().min(1).default('v1'),
  DATA_ENCRYPTION_KEYRING: z.string().min(1),
  MEDIA_FINGERPRINT_KEY_CURRENT_VERSION: z.string().min(1).default('v1'),
  MEDIA_FINGERPRINT_KEYRING: z.string().min(1),
  ADMIN_BOOTSTRAP_USERNAME: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(3).default('sakura'),
  ),
  ADMIN_BOOTSTRAP_PASSWORD_FILE: optionalString,
  ADMIN_BOOTSTRAP_PASSWORD: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(6).optional(),
  ),
  DASHSCOPE_API_KEY: z.string().min(1),
  AGENT_MODEL: z.string().default('qwen3.7-plus'),
  VISION_MODEL: z.string().default('qwen3.6-flash'),
  ASR_MODEL: z.string().default('qwen3-asr-flash-realtime'),
  TTS_MODEL: z.string().default('qwen-audio-3.0-tts-plus'),
  AMAP_WEB_SERVICE_KEY: z.string().min(1),
  MEDIA_TEMP_DIR: z.string().default('./data/verification-temp'),
  MEDIA_UPLOAD_STAGING_DIR: z.string().default('./data/upload-staging'),
  MEDIA_EVIDENCE_DIR: z.string().default('./data/evidence'),
  MEDIA_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10_485_760),
  MEDIA_QUOTA_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  SSE_RESUME_WINDOW_SECONDS: z.coerce.number().int().positive().default(86_400),
  VOICE_WS_MAX_SESSION_SECONDS: z.coerce.number().int().positive().default(70),
  TRUST_PROXY: booleanString.default(false),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
});

export type AppEnv = z.infer<typeof environmentSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败: ${z.prettifyError(parsed.error)}`);
  }

  const env = parsed.data;
  const placeholderValues = [
    env.DATABASE_URL,
    env.AUTH_TOKEN_SECRET,
    env.ADMIN_SESSION_SECRET,
    env.DATA_ENCRYPTION_KEYRING,
    env.MEDIA_FINGERPRINT_KEYRING,
    env.DASHSCOPE_API_KEY,
    env.AMAP_WEB_SERVICE_KEY,
  ];
  if (placeholderValues.some((value) => value.toLowerCase().includes('replace_with'))) {
    throw new Error('检测到未替换的占位配置, 请先运行同步脚本并填写真实服务 Key');
  }
  if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test') {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error('staging/production 必须显式提供 DATABASE_URL 和 REDIS_URL');
    }
  }
  const origins = env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
  if (env.APP_ENV === 'production' && origins.includes('*')) {
    throw new Error('生产环境禁止使用通配 CORS Origin');
  }
  if (env.APP_ENV !== 'development' && env.ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error('staging/production 禁止通过环境变量提供管理员引导密码');
  }

  const directories = [
    path.resolve(env.MEDIA_TEMP_DIR),
    path.resolve(env.MEDIA_UPLOAD_STAGING_DIR),
    path.resolve(env.MEDIA_EVIDENCE_DIR),
  ];
  if (new Set(directories).size !== directories.length) {
    throw new Error('临时验真、上传暂存和证据目录必须物理隔离');
  }

  assertKeyring(env.DATA_ENCRYPTION_KEYRING, env.DATA_ENCRYPTION_KEY_CURRENT_VERSION, '数据加密');
  assertKeyring(env.MEDIA_FINGERPRINT_KEYRING, env.MEDIA_FINGERPRINT_KEY_CURRENT_VERSION, '媒体指纹');
  cachedEnv = env;
  return env;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}

export function parseKeyring(keyring: string): Map<string, Buffer> {
  return new Map(
    keyring.split(',').map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0) throw new Error('密钥环格式无效');
      const version = entry.slice(0, separator);
      const value = Buffer.from(entry.slice(separator + 1), 'base64');
      if (value.length < 32) throw new Error(`密钥版本 ${version} 长度不足 32 字节`);
      return [version, value];
    }),
  );
}

function assertKeyring(keyring: string, currentVersion: string, label: string): void {
  const parsed = parseKeyring(keyring);
  if (!parsed.has(currentVersion)) {
    throw new Error(`${label}密钥环不包含当前版本 ${currentVersion}`);
  }
}
