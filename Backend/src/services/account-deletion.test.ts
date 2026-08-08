import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/tokens.js', () => ({ revokeUserSessions: vi.fn() }));
vi.mock('../db/index.js', () => ({
  auditEvents: {},
  evidenceMedia: {},
  installationAccounts: {},
  installationChallenges: {},
  mediaUploadSessions: {},
  observations: {},
  userFeedback: {},
  db: {},
}));
vi.mock('./media-storage.js', () => ({
  removeEvidenceFile: vi.fn(),
  removeUploadDirectory: vi.fn(),
}));

import {
  AccountDeletionError,
  deleteInstallationAccount,
  type AccountDeletionDependencies,
} from './account-deletion.js';

const installationId = '00000000-0000-4000-8000-000000000001';

function dependencies(): AccountDeletionDependencies {
  return {
    beginDeletion: vi.fn().mockResolvedValue({
      observationsWithdrawn: 3,
      feedbackDeleted: 4,
    }),
    revokeSessions: vi.fn().mockResolvedValue(undefined),
    listUploadIds: vi.fn().mockResolvedValue(['00000000-0000-4000-8000-000000000010']),
    listMedia: vi.fn().mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000020', storagePath: 'one.webp' },
      { id: '00000000-0000-4000-8000-000000000030', storagePath: 'two.webp' },
    ]),
    removeUpload: vi.fn().mockResolvedValue(undefined),
    removeMedia: vi.fn().mockResolvedValue(undefined),
    markMediaDeleted: vi.fn().mockResolvedValue(undefined),
    finalizeDeletion: vi.fn().mockResolvedValue({ kind: 'deleted' }),
  };
}

describe('匿名账户删除编排', () => {
  beforeEach(() => vi.clearAllMocks());

  it('先限制账户并撤销会话，再清理上传、媒体和可归属数据', async () => {
    const deps = dependencies();

    const result = await deleteInstallationAccount(installationId, deps);

    expect(result).toEqual({
      mediaDeleted: 2,
      uploadSessionsDeleted: 1,
      observationsWithdrawn: 3,
      feedbackDeleted: 4,
    });
    expect(deps.revokeSessions).toHaveBeenCalledWith(installationId);
    expect(deps.removeUpload).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000010');
    expect(deps.markMediaDeleted).toHaveBeenNthCalledWith(
      1,
      installationId,
      '00000000-0000-4000-8000-000000000020',
    );
    expect(deps.finalizeDeletion).toHaveBeenCalledOnce();
  });

  it('文件删除失败时保留 deleting 状态供维护任务重试', async () => {
    const deps = dependencies();
    let observationIsPublic = true;
    vi.mocked(deps.beginDeletion).mockImplementation(async () => {
      observationIsPublic = false;
      return {
        observationsWithdrawn: 3,
        feedbackDeleted: 4,
      };
    });
    vi.mocked(deps.removeMedia)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('locked'));

    await expect(deleteInstallationAccount(installationId, deps))
      .rejects.toMatchObject({ code: 'ACCOUNT_MEDIA_CLEANUP_FAILED' });
    expect(deps.markMediaDeleted).toHaveBeenCalledTimes(1);
    expect(deps.finalizeDeletion).not.toHaveBeenCalled();
    expect(observationIsPublic).toBe(false);
  });

  it('最终复核发现并发残留时不删除账户并要求后台重试', async () => {
    const deps = dependencies();
    vi.mocked(deps.finalizeDeletion).mockResolvedValue({ kind: 'cleanup_required' });

    await expect(deleteInstallationAccount(installationId, deps))
      .rejects.toBeInstanceOf(AccountDeletionError);
  });
});
