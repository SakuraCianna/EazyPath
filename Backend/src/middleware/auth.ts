import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types.js';
import { fail } from '../lib/api-response.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { db, installationAccounts } from '../db/index.js';
import { eq } from 'drizzle-orm';

export const requireUser = authenticateInstallation(new Set(['active']));
export const requireUserForAccountDeletion = authenticateInstallation(new Set(['active', 'suspended', 'deleting']));

function authenticateInstallation(allowedStatuses: ReadonlySet<string>): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return fail(c, 401, 'AUTH_REQUIRED', '需要匿名安装账户访问令牌');
    }
    const installationId = await verifyAccessToken(authorization.slice(7));
    if (!installationId) {
      return fail(c, 401, 'AUTH_TOKEN_INVALID', '访问令牌无效或已过期', { retryable: true });
    }
    const [account] = await db.select({ status: installationAccounts.status })
      .from(installationAccounts)
      .where(eq(installationAccounts.id, installationId))
      .limit(1);
    if (!account) {
      return fail(c, 401, 'AUTH_TOKEN_INVALID', '访问令牌对应的匿名账户不存在');
    }
    if (!allowedStatuses.has(account.status)) {
      return fail(c, 403, 'ACCOUNT_NOT_ACTIVE', '匿名账户当前不可执行此操作');
    }
    c.set('installationId', installationId);
    await next();
  };
}
