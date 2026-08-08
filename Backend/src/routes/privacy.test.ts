import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deleteInstallationAccount: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  agentTasks: { installationId: {} },
  communityReviewVotes: { installationId: {} },
  observations: { installationId: {} },
  userProfiles: { installationId: {} },
  db: { select: vi.fn() },
}));
vi.mock('../services/account-deletion.js', () => {
  class AccountDeletionError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return { AccountDeletionError, deleteInstallationAccount: state.deleteInstallationAccount };
});
vi.mock('../middleware/auth.js', () => {
  const authenticate = async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('installationId', '00000000-0000-4000-8000-000000000001');
    await next();
  };
  return { requireUser: authenticate, requireUserForAccountDeletion: authenticate };
});

import { AccountDeletionError } from '../services/account-deletion.js';
import { privacyRouter } from './privacy.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.route('/privacy', privacyRouter);
  return app;
}

describe('匿名账户删除路由', () => {
  beforeEach(() => vi.clearAllMocks());

  it('返回已清理的数据数量和透明隐私说明', async () => {
    state.deleteInstallationAccount.mockResolvedValue({
      mediaDeleted: 2,
      uploadSessionsDeleted: 1,
      observationsWithdrawn: 3,
      feedbackDeleted: 4,
    });

    const response = await testApp().request('/privacy/account', { method: 'DELETE' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      deleted: true,
      media_deleted: 2,
      upload_sessions_deleted: 1,
      observations_withdrawn: 3,
      feedback_deleted: 4,
    });
    expect(body.data.notice).toContain('社区观测已停止公开');
  });

  it('同步清理失败时返回可重试错误且由后台继续处理', async () => {
    state.deleteInstallationAccount.mockRejectedValue(
      new AccountDeletionError('ACCOUNT_MEDIA_CLEANUP_FAILED'),
    );

    const response = await testApp().request('/privacy/account', { method: 'DELETE' });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe('ACCOUNT_MEDIA_CLEANUP_FAILED');
    expect(body.error.retryable).toBe(true);
  });
});
