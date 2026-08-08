import { createMiddleware } from 'hono/factory';
import { fail } from '../lib/api-response.js';
import type { AppBindings } from '../types.js';

export const requireAdminPermission = (permission: string) => createMiddleware<AppBindings>(async (c, next) => {
  const permissions = c.get('adminPermissions');
  if (!permissions.includes('*') && !permissions.includes(permission)) {
    return fail(c, 403, 'ADMIN_PERMISSION_DENIED', '没有执行此操作的权限');
  }
  await next();
});
