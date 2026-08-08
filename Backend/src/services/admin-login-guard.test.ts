import { describe, expect, it } from 'vitest';
import { fingerprintAdminLoginSource } from './admin-login-guard.js';

describe('管理员登录来源指纹', () => {
  const secret = 'admin-session-secret-at-least-32-bytes';

  it('未信任代理时忽略可伪造的转发头', () => {
    const first = fingerprintAdminLoginSource({
      trustProxy: false,
      realIp: '203.0.113.10',
      forwardedFor: '198.51.100.7',
    }, secret);
    const second = fingerprintAdminLoginSource({
      trustProxy: false,
      realIp: '192.0.2.8',
      forwardedFor: '192.0.2.9',
    }, secret);
    expect(first).toBe(second);
  });

  it('信任代理时使用最靠近代理提供的真实来源且不返回原始 IP', () => {
    const fingerprint = fingerprintAdminLoginSource({
      trustProxy: true,
      realIp: '203.0.113.10',
      forwardedFor: '198.51.100.7, 10.0.0.4',
    }, secret);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('203.0.113.10');
  });
});
