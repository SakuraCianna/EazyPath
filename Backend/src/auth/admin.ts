import { and, eq, gt, isNull } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { getEnv } from '../config/env.js';
import { adminRoles, adminSessions, adminUsers, db } from '../db/index.js';
import {
  isAdminSessionIdle,
  shouldTouchAdminSession,
} from '../domain/admin-security.js';
import { constantTimeEquals, hmacSha256 } from '../lib/crypto.js';
import { fail } from '../lib/api-response.js';
import type { AppBindings } from '../types.js';

export const ADMIN_COOKIE_NAME = 'eazypath_admin_session';

export function adminTokenHash(token: string): string {
  return hmacSha256(token, Buffer.from(getEnv().ADMIN_SESSION_SECRET, 'utf8'));
}

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = getCookie(c, ADMIN_COOKIE_NAME);
  if (!token) return fail(c, 401, 'ADMIN_AUTH_REQUIRED', '请先登录管理端');
  const now = new Date();
  const [session] = await db
    .select({
      sessionId: adminSessions.id,
      csrfHash: adminSessions.csrfHash,
      lastSeenAt: adminSessions.lastSeenAt,
      userId: adminUsers.id,
      username: adminUsers.username,
      status: adminUsers.status,
      roleCode: adminRoles.code,
      permissions: adminRoles.permissions,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
    .innerJoin(adminRoles, eq(adminUsers.roleId, adminRoles.id))
    .where(and(eq(adminSessions.tokenHash, adminTokenHash(token)), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, now)))
    .limit(1);
  if (!session || session.status !== 'active') return fail(c, 401, 'ADMIN_SESSION_INVALID', '管理端会话无效或已过期');
  if (isAdminSessionIdle(session.lastSeenAt, now)) {
    await db.update(adminSessions).set({ revokedAt: now }).where(and(eq(adminSessions.id, session.sessionId), isNull(adminSessions.revokedAt)));
    return fail(c, 401, 'ADMIN_SESSION_IDLE_TIMEOUT', '管理端会话因长时间未操作已失效');
  }
  if (shouldTouchAdminSession(session.lastSeenAt, now)) {
    await db.update(adminSessions).set({ lastSeenAt: now }).where(and(eq(adminSessions.id, session.sessionId), isNull(adminSessions.revokedAt)));
  }
  c.set('adminUserId', session.userId);
  c.set('adminSessionId', session.sessionId);
  c.set('adminUsername', session.username);
  c.set('adminRoleCode', session.roleCode);
  c.set('adminPermissions', session.permissions);
  c.set('adminCsrfHash', session.csrfHash);
  await next();
};

export const requireAdminCsrf: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const csrf = c.req.header('x-csrf-token');
  if (!csrf) return fail(c, 403, 'CSRF_INVALID', '缺少管理端 CSRF 令牌');
  if (!constantTimeEquals(c.get('adminCsrfHash'), adminTokenHash(csrf))) {
    return fail(c, 403, 'CSRF_INVALID', '管理端 CSRF 令牌无效');
  }
  await next();
};
