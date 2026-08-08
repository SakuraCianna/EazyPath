import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types.js';
import { fail } from '../lib/api-response.js';
import { verifyAccessToken } from '../auth/tokens.js';

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return fail(c, 401, 'AUTH_REQUIRED', '需要匿名安装账户访问令牌');
  }
  const installationId = await verifyAccessToken(authorization.slice(7));
  if (!installationId) {
    return fail(c, 401, 'AUTH_TOKEN_INVALID', '访问令牌无效或已过期', { retryable: true });
  }
  c.set('installationId', installationId);
  await next();
};
