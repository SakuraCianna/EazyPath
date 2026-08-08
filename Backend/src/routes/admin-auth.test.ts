import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  loginAdmin: vi.fn(),
  rotateAdminCsrf: vi.fn(),
  revokeAdminSessions: vi.fn(),
  changeAdminPassword: vi.fn(),
}));
const guard = vi.hoisted(() => {
  class AdminLoginProtectionUnavailableError extends Error {}
  return {
    acquireAdminLoginPermit: vi.fn(),
    fingerprintAdminLoginSource: vi.fn(() => 'source-fingerprint'),
    AdminLoginProtectionUnavailableError,
    release: vi.fn(),
  };
});

vi.mock('../services/admin-auth.js', () => service);
vi.mock('../services/admin-login-guard.js', () => guard);
vi.mock('../config/env.js', () => ({ getEnv: () => ({ APP_ENV: 'development' }) }));
vi.mock('../auth/admin.js', () => ({
  ADMIN_COOKIE_NAME: 'eazypath_admin_session',
  requireAdmin: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('adminUserId', '00000000-0000-4000-8000-000000000001');
    c.set('adminSessionId', '00000000-0000-4000-8000-000000000002');
    c.set('adminUsername', 'sakura');
    c.set('adminRoleCode', 'super_admin');
    c.set('adminPermissions', ['*']);
    c.set('adminCsrfHash', 'hash');
    await next();
  },
  requireAdminCsrf: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { adminAuthRouter } from './admin-auth.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    await next();
  });
  app.route('/auth', adminAuthRouter);
  return app;
}

describe('管理员认证路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guard.release.mockResolvedValue(undefined);
    guard.acquireAdminLoginPermit.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
      release: guard.release,
    });
  });

  it('参数错误和凭据错误都返回统一登录失败响应', async () => {
    service.loginAdmin.mockResolvedValue(null);
    const app = testApp();
    const malformed = await app.request('/auth/login', { method: 'POST', body: '{}' });
    const invalid = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sakura', password: 'wrong' }),
    });

    expect(malformed.status).toBe(401);
    expect((await malformed.json()).code).toBe('ADMIN_LOGIN_FAILED');
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).code).toBe('ADMIN_LOGIN_FAILED');
  });

  it('登录成功设置 HttpOnly 严格同站 Cookie 并返回 CSRF', async () => {
    service.loginAdmin.mockResolvedValue({
      sessionToken: 'session-token',
      csrfToken: 'csrf-token',
      expiresAt: new Date('2026-08-09T08:00:00.000Z'),
      identity: {
        id: '00000000-0000-4000-8000-000000000001',
        username: 'sakura',
        roleCode: 'super_admin',
        permissions: ['*'],
      },
    });
    const response = await testApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sakura', password: 'valid-password' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(body.data.csrf_token).toBe('csrf-token');
    expect(body.data.user.role_code).toBe('super_admin');
    expect(guard.release).toHaveBeenCalledOnce();
  });

  it('共享限流拒绝时不执行高成本密码校验', async () => {
    guard.acquireAdminLoginPermit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 45,
      release: vi.fn().mockResolvedValue(undefined),
    });
    const response = await testApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sakura', password: 'wrong' }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('45');
    expect(service.loginAdmin).not.toHaveBeenCalled();
  });

  it('Redis 登录保护不可用时失败关闭', async () => {
    guard.acquireAdminLoginPermit.mockRejectedValue(new guard.AdminLoginProtectionUnavailableError());
    const response = await testApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sakura', password: 'valid-password' }),
    });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('ADMIN_LOGIN_PROTECTION_UNAVAILABLE');
    expect(service.loginAdmin).not.toHaveBeenCalled();
  });

  it('返回当前身份并可安全轮换 CSRF', async () => {
    service.rotateAdminCsrf.mockResolvedValue('rotated-csrf');
    const app = testApp();
    const me = await app.request('/auth/me');
    const csrf = await app.request('/auth/csrf', { method: 'POST' });

    expect((await me.json()).data).toMatchObject({ username: 'sakura', role_code: 'super_admin' });
    expect((await csrf.json()).data.csrf_token).toBe('rotated-csrf');
    expect(service.rotateAdminCsrf).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002');
  });

  it('改密成功后清除 Cookie 并要求重新登录', async () => {
    service.changeAdminPassword.mockResolvedValue({ ok: true });
    const response = await testApp().request('/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: 'old-password', new_password: 'RiverStone2026!' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await response.json()).data.all_sessions_revoked).toBe(true);
  });
});
