import { describe, expect, it } from 'vitest';
import { buildEnvEntries, upsertGradleProperty } from './env-template.mjs';

function toMap(entries) {
  return new Map(entries.map(([, name, value]) => [name, value]));
}

describe('buildEnvEntries', () => {
  it('保留未来平台 Key 并生成 Docker 数据库连接串', () => {
    const current = new Map([
      ['POSTGRES_PASSWORD', 'safe_password-12345'],
      ['CTRIP_API_KEY', 'future-ctrip-key'],
    ]);

    const values = toMap(buildEnvEntries(current));

    expect(values.get('DATABASE_DOCKER_URL')).toContain('safe_password-12345');
    expect(values.get('CTRIP_API_KEY')).toBe('future-ctrip-key');
    expect(values.has('MEITUAN_API_KEY')).toBe(true);
    expect(values.has('DIDI_API_KEY')).toBe(true);
    expect(values.has('RAILWAY_12306_API_KEY')).toBe(true);
    expect(values.has('AMAP_WEB_SECURITY_KEY')).toBe(true);
  });

  it('拒绝会被 Compose 再次插值的 PostgreSQL 密码', () => {
    const current = new Map([['POSTGRES_PASSWORD', 'unsafe$password-12345']]);

    expect(() => buildEnvEntries(current)).toThrow('仅使用字母、数字、下划线或连字符');
  });

  it('从示例文件同步时替换安全凭据占位值但保留第三方服务 Key 占位值', () => {
    const current = new Map([
      ['POSTGRES_PASSWORD', 'replace_with_random_password'],
      ['AUTH_TOKEN_SECRET', 'replace_with_at_least_32_random_characters'],
      ['ADMIN_SESSION_SECRET', 'replace_with_at_least_32_random_characters'],
      ['DATA_ENCRYPTION_KEYRING', 'v1:replace_with_32_byte_base64_key'],
      ['MEDIA_FINGERPRINT_KEYRING', 'v1:replace_with_different_32_byte_base64_key'],
      ['ADMIN_BOOTSTRAP_PASSWORD', 'replace_with_local_development_password'],
      ['DASHSCOPE_API_KEY', 'replace_with_dashscope_api_key'],
      ['DASHSCOPE_WORKSPACE_ID', 'workspace-bj-01'],
    ]);

    const values = toMap(buildEnvEntries(current));

    expect(values.get('POSTGRES_PASSWORD')).not.toContain('replace_with_');
    expect(values.get('AUTH_TOKEN_SECRET')).not.toContain('replace_with_');
    expect(values.get('ADMIN_SESSION_SECRET')).not.toContain('replace_with_');
    expect(values.get('DATA_ENCRYPTION_KEYRING')).not.toContain('replace_with_');
    expect(values.get('MEDIA_FINGERPRINT_KEYRING')).not.toContain('replace_with_');
    expect(values.get('ADMIN_BOOTSTRAP_PASSWORD')).not.toContain('replace_with_');
    expect(values.get('DASHSCOPE_API_KEY')).toBe('replace_with_dashscope_api_key');
    expect(values.get('DASHSCOPE_WORKSPACE_ID')).toBe('workspace-bj-01');
  });

  it('拒绝静默删除非默认的旧高级配置', () => {
    const current = new Map([['WORKER_CONCURRENCY', '12']]);

    expect(() => buildEnvEntries(current)).toThrow('WORKER_CONCURRENCY');
  });

  it('拒绝静默删除未知的未来配置', () => {
    expect(() => buildEnvEntries(new Map([['UNKNOWN_FUTURE_KEY', 'value']]))).toThrow('UNKNOWN_FUTURE_KEY');
  });

  it('非开发环境不生成或保留普通管理员密码', () => {
    const current = new Map([
      ['APP_ENV', 'production'],
      ['POSTGRES_PASSWORD', 'safe-production-password'],
      ['ADMIN_BOOTSTRAP_PASSWORD', 'old-development-password'],
    ]);

    const values = toMap(buildEnvEntries(current));

    expect(values.get('ADMIN_BOOTSTRAP_PASSWORD')).toBe('');
  });

  it('迁移 Android Key 时保留其他 Gradle 属性并替换旧值', () => {
    const content = 'EAZYPATH_API_BASE_URL=https://api.example.com/\nAMAP_ANDROID_KEY=old\n';

    expect(upsertGradleProperty(content, 'AMAP_ANDROID_KEY', 'new-secret')).toBe(
      'EAZYPATH_API_BASE_URL=https://api.example.com/\nAMAP_ANDROID_KEY=new-secret\n',
    );
  });
});
