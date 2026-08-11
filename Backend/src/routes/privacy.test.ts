import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deleteInstallationAccount: vi.fn(),
  listAiConsents: vi.fn(),
  setAiConsent: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  aiProcessingConsents: { installationId: {} },
  agentTasks: { installationId: {} },
  communityReviewVotes: { installationId: {} },
  evidenceMedia: { installationId: {} },
  observations: { installationId: {} },
  userFeedback: { installationId: {} },
  userProfiles: { installationId: {} },
  db: { select: vi.fn() },
}));
vi.mock('../services/ai-consent.js', () => ({
  AiConsentVersionConflictError: class extends Error {},
  listAiConsents: state.listAiConsents,
  setAiConsent: state.setAiConsent,
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
import { AiConsentVersionConflictError } from '../services/ai-consent.js';
import { privacyRouter } from './privacy.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.route('/privacy', privacyRouter);
  return app;
}

describe('AI 分项同意路由', () => {
  beforeEach(() => vi.clearAllMocks());

  it('返回四类能力的当前同意快照', async () => {
    state.listAiConsents.mockResolvedValue([{ capability: 'asr', granted: false }]);

    const response = await testApp().request('/privacy/ai-consents');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.policy_version).toBe('2026-08-11');
    expect(body.data.consents).toEqual([{ capability: 'asr', granted: false }]);
  });

  it('只接受当前政策版本并更新指定能力', async () => {
    state.setAiConsent.mockResolvedValue({ capability: 'asr', granted: true });

    const response = await testApp().request('/privacy/ai-consents/asr', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true, policy_version: '2026-08-11', expected_version: null }),
    });

    expect(response.status).toBe(200);
    expect(state.setAiConsent).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'asr',
      true,
      null,
    );
  });

  it('过期政策返回 409 且不写入同意', async () => {
    const response = await testApp().request('/privacy/ai-consents/tts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true, policy_version: '2025-01-01', expected_version: null }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AI_CONSENT_POLICY_STALE');
    expect(state.setAiConsent).not.toHaveBeenCalled();
  });

  it('撤回不受客户端旧政策版本阻断', async () => {
    state.setAiConsent.mockResolvedValue({ capability: 'asr', granted: false });

    const response = await testApp().request('/privacy/ai-consents/asr', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: false, policy_version: '2025-01-01', expected_version: 2 }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(state.setAiConsent).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'asr',
      false,
      2,
    );
  });

  it('未知能力返回 404', async () => {
    const response = await testApp().request('/privacy/ai-consents/location', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true, policy_version: '2026-08-11', expected_version: null }),
    });

    expect(response.status).toBe(404);
    expect(state.setAiConsent).not.toHaveBeenCalled();
  });

  it('陈旧决策版本返回 409', async () => {
    state.setAiConsent.mockRejectedValue(new AiConsentVersionConflictError());

    const response = await testApp().request('/privacy/ai-consents/vision', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true, policy_version: '2026-08-11', expected_version: 1 }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AI_CONSENT_VERSION_CONFLICT');
  });
});

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
