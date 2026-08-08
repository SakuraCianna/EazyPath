import { deleteCookie, setCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { z } from 'zod';
import { ADMIN_COOKIE_NAME, requireAdmin, requireAdminCsrf } from '../auth/admin.js';
import { getEnv } from '../config/env.js';
import { fail, ok } from '../lib/api-response.js';
import {
  acquireAdminLoginPermit,
  AdminLoginProtectionUnavailableError,
  fingerprintAdminLoginSource,
} from '../services/admin-login-guard.js';
import {
  changeAdminPassword,
  loginAdmin,
  revokeAdminSessions,
  rotateAdminCsrf,
} from '../services/admin-auth.js';
import type { AppBindings } from '../types.js';

const loginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(1).max(256),
});
const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(12).max(256),
});

export const adminAuthRouter = new Hono<AppBindings>();

adminAuthRouter.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  await next();
});

adminAuthRouter.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return loginFailed(c);
  const env = getEnv();
  const realIp = c.req.header('x-real-ip');
  const forwardedFor = c.req.header('x-forwarded-for');
  const sourceFingerprint = fingerprintAdminLoginSource({
    trustProxy: env.TRUST_PROXY,
    ...(realIp ? { realIp } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
  }, env.ADMIN_SESSION_SECRET);
  let permit;
  try {
    permit = await acquireAdminLoginPermit(sourceFingerprint);
  } catch (error: unknown) {
    if (error instanceof AdminLoginProtectionUnavailableError) {
      return fail(c, 503, 'ADMIN_LOGIN_PROTECTION_UNAVAILABLE', '管理员登录保护暂不可用', { retryable: true });
    }
    throw error;
  }
  if (!permit.allowed) {
    c.header('Retry-After', String(permit.retryAfterSeconds));
    return fail(c, 429, 'ADMIN_LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后再试', { retryable: true });
  }

  let result;
  try {
    result = await loginAdmin(
      parsed.data.username,
      parsed.data.password,
      c.get('requestId'),
    );
  } finally {
    await permit.release().catch(() => undefined);
  }
  if (!result) return loginFailed(c);

  setCookie(c, ADMIN_COOKIE_NAME, result.sessionToken, {
    httpOnly: true,
    secure: env.APP_ENV !== 'development',
    sameSite: 'Strict',
    path: '/api/v1/admin',
    expires: result.expiresAt,
  });
  return ok(c, {
    user: {
      id: result.identity.id,
      username: result.identity.username,
      role_code: result.identity.roleCode,
      permissions: result.identity.permissions,
    },
    csrf_token: result.csrfToken,
    expires_at: result.expiresAt,
  });
});

adminAuthRouter.get('/me', requireAdmin, async (c) => ok(c, {
  id: c.get('adminUserId'),
  username: c.get('adminUsername'),
  role_code: c.get('adminRoleCode'),
  permissions: c.get('adminPermissions'),
}));

adminAuthRouter.post('/csrf', requireAdmin, async (c) => {
  const csrfToken = await rotateAdminCsrf(c.get('adminSessionId'));
  if (!csrfToken) return fail(c, 401, 'ADMIN_SESSION_INVALID', '管理端会话无效或已过期');
  return ok(c, { csrf_token: csrfToken });
});

adminAuthRouter.post('/logout', requireAdmin, requireAdminCsrf, async (c) => {
  await revokeAdminSessions(
    c.get('adminUserId'),
    c.get('adminSessionId'),
    false,
    c.get('requestId'),
  );
  clearAdminCookie(c);
  return ok(c, { logged_out: true });
});

adminAuthRouter.post('/logout-all', requireAdmin, requireAdminCsrf, async (c) => {
  await revokeAdminSessions(
    c.get('adminUserId'),
    c.get('adminSessionId'),
    true,
    c.get('requestId'),
  );
  clearAdminCookie(c);
  return ok(c, { logged_out: true, all_sessions_revoked: true });
});

adminAuthRouter.post('/change-password', requireAdmin, requireAdminCsrf, async (c) => {
  const parsed = changePasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_PASSWORD_INVALID', '密码参数无效');
  const result = await changeAdminPassword(
    c.get('adminUserId'),
    parsed.data.current_password,
    parsed.data.new_password,
    c.get('requestId'),
  );
  if (!result.ok && result.reason === 'CURRENT_PASSWORD_INVALID') {
    return fail(c, 401, 'ADMIN_CURRENT_PASSWORD_INVALID', '当前密码错误');
  }
  if (!result.ok) {
    return fail(c, 422, 'ADMIN_PASSWORD_POLICY_INVALID', result.message ?? '新密码不符合安全要求');
  }
  clearAdminCookie(c);
  return ok(c, { password_changed: true, all_sessions_revoked: true }, '密码已修改，请重新登录');
});

function clearAdminCookie(c: Parameters<typeof ok>[0]): void {
  deleteCookie(c, ADMIN_COOKIE_NAME, { path: '/api/v1/admin' });
}

function loginFailed(c: Parameters<typeof fail>[0]) {
  return fail(c, 401, 'ADMIN_LOGIN_FAILED', '用户名或密码错误');
}
