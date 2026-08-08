import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvForTests } from './env.js';

const managedKeys = [
  'APP_ENV',
  'CORS_ALLOWED_ORIGINS',
  'DATABASE_URL',
  'REDIS_URL',
  'AUTH_TOKEN_SECRET',
  'ADMIN_SESSION_SECRET',
  'DATA_ENCRYPTION_KEY_CURRENT_VERSION',
  'DATA_ENCRYPTION_KEYRING',
  'MEDIA_FINGERPRINT_KEY_CURRENT_VERSION',
  'MEDIA_FINGERPRINT_KEYRING',
  'ADMIN_BOOTSTRAP_USERNAME',
  'ADMIN_BOOTSTRAP_PASSWORD_FILE',
  'ADMIN_BOOTSTRAP_PASSWORD',
  'DASHSCOPE_API_KEY',
  'AMAP_WEB_SERVICE_KEY',
  'AMAP_ANDROID_KEY',
] as const;

const originalValues = new Map(managedKeys.map((key) => [key, process.env[key]]));

describe('getEnv', () => {
  beforeEach(() => {
    resetEnvForTests();
    for (const key of managedKeys) delete process.env[key];
    process.env.AUTH_TOKEN_SECRET = 'a'.repeat(32);
    process.env.ADMIN_SESSION_SECRET = 'b'.repeat(32);
    process.env.DATA_ENCRYPTION_KEYRING = `v1:${Buffer.alloc(32, 1).toString('base64')}`;
    process.env.MEDIA_FINGERPRINT_KEYRING = `v1:${Buffer.alloc(32, 2).toString('base64')}`;
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    process.env.AMAP_WEB_SERVICE_KEY = 'amap-test-key';
  });

  afterEach(() => resetEnvForTests());

  afterAll(() => {
    for (const key of managedKeys) {
      const value = originalValues.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvForTests();
  });

  it('为本地开发提供安全边界内的非敏感默认值', () => {
    process.env.AMAP_ANDROID_KEY = 'must-not-enter-backend-config';

    const env = getEnv();

    expect(env.DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/eazypath');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.CORS_ALLOWED_ORIGINS).toContain('http://localhost:5173');
    expect(env.ADMIN_BOOTSTRAP_USERNAME).toBe('sakura');
    expect('AMAP_ANDROID_KEY' in env).toBe(false);
  });

  it('生产环境拒绝通过普通环境变量提供管理员引导密码', () => {
    process.env.APP_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://eazypath:test@postgres:5432/eazypath';
    process.env.REDIS_URL = 'redis://redis:6379';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'not-allowed-in-production';

    expect(() => getEnv()).toThrow('staging/production 禁止通过环境变量提供管理员引导密码');
  });

  it('生产环境拒绝回退到本地数据库和 Redis 默认地址', () => {
    process.env.APP_ENV = 'production';

    expect(() => getEnv()).toThrow('staging/production 必须显式提供 DATABASE_URL 和 REDIS_URL');
  });

  it('拒绝使用模板中的占位服务 Key 启动', () => {
    process.env.AMAP_WEB_SERVICE_KEY = 'replace_with_amap_web_service_key';

    expect(() => getEnv()).toThrow('检测到未替换的占位配置');
  });
});
