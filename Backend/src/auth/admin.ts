import { and, eq, gt, isNull } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { getEnv } from '../config/env.js';
import { adminRoles, adminSessions, adminUsers, db } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { fail } from '../lib/api-response.js';
import type { AppBindings } from '../types.js';

export const ADMIN_COOKIE_NAME = 'eazypath_admin_session';

export function adminTokenHash(token: string): string {
  return sha256(`${token}.${getEnv().ADMIN_SESSION_SECRET}`);
}

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = getCookie(c, ADMIN_COOKIE_NAME);
  if (!token) return fail(c, 401, 'ADMIN_AUTH_REQUIRED', '请先登录管理端');
  const [session] = await db
    .select({ userId: adminUsers.id, status: adminUsers.status, permissions: adminRoles.permissions })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
    .innerJoin(adminRoles, eq(adminUsers.roleId, adminRoles.id))
    .where(and(eq(adminSessions.tokenHash, adminTokenHash(token)), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, new Date())))
    .limit(1);
  if (!session || session.status !== 'active') return fail(c, 401, 'ADMIN_SESSION_INVALID', '管理端会话无效或已过期');
  c.set('adminUserId', session.userId);
  c.set('adminPermissions', session.permissions);
  await next();
};

export const requireAdminCsrf: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const token = getCookie(c, ADMIN_COOKIE_NAME);
  const csrf = c.req.header('x-csrf-token');
  if (!token || !csrf) return fail(c, 403, 'CSRF_INVALID', '缺少管理端 CSRF 令牌');
  const [session] = await db.select({ csrfHash: adminSessions.csrfHash }).from(adminSessions).where(and(eq(adminSessions.tokenHash, adminTokenHash(token)), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, new Date()))).limit(1);
  if (!session || session.csrfHash !== adminTokenHash(csrf)) return fail(c, 403, 'CSRF_INVALID', '管理端 CSRF 令牌无效');
  await next();
};
