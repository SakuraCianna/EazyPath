import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: 'active',
  verifyAccessToken: vi.fn(),
}));

vi.mock('../auth/tokens.js', () => ({ verifyAccessToken: state.verifyAccessToken }));
vi.mock('../db/index.js', () => ({
  installationAccounts: { id: {}, status: {} },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => state.status ? [{ status: state.status }] : []),
        })),
      })),
    })),
  },
}));

import { requireUser, requireUserForAccountDeletion } from './auth.js';
import type { AppBindings } from '../types.js';

function appWith(middleware: typeof requireUser) {
  const app = new Hono<AppBindings>();
  app.get('/', middleware, (c) => c.json({ installationId: c.get('installationId') }));
  return app;
}

describe('匿名账户状态鉴权', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.status = 'active';
    state.verifyAccessToken.mockResolvedValue('00000000-0000-4000-8000-000000000001');
  });

  it('普通用户接口只允许 active 账户', async () => {
    state.status = 'deleting';
    const response = await appWith(requireUser).request('/', {
      headers: { authorization: 'Bearer token' },
    });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('删除中账户仍可重试账户删除入口', async () => {
    state.status = 'deleting';
    const response = await appWith(requireUserForAccountDeletion).request('/', {
      headers: { authorization: 'Bearer token' },
    });

    expect(response.status).toBe(200);
  });

  it('数据库中不存在账户时拒绝残留 access token', async () => {
    state.status = '';
    const response = await appWith(requireUser).request('/', {
      headers: { authorization: 'Bearer token' },
    });

    expect(response.status).toBe(401);
  });
});
