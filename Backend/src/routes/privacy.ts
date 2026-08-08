import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { revokeUserSessions } from '../auth/tokens.js';
import {
  agentTasks,
  communityReviewVotes,
  db,
  evidenceMedia,
  installationAccounts,
  observations,
  userProfiles,
} from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { removeEvidenceFile } from '../services/media-storage.js';
import type { AppBindings } from '../types.js';

export const privacyRouter = new Hono<AppBindings>();
privacyRouter.use('*', requireUser);

privacyRouter.get('/export', async (c) => {
  const installationId = c.get('installationId');
  const [profile, tasks, observationRows, votes] = await Promise.all([
    db.select().from(userProfiles).where(eq(userProfiles.installationId, installationId)),
    db.select().from(agentTasks).where(eq(agentTasks.installationId, installationId)),
    db.select().from(observations).where(eq(observations.installationId, installationId)),
    db.select().from(communityReviewVotes).where(eq(communityReviewVotes.installationId, installationId)),
  ]);
  c.header('content-disposition', `attachment; filename="eazypath-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return ok(c, {
    exported_at: new Date().toISOString(),
    profile,
    tasks,
    observations: observationRows,
    community_review_votes: votes,
    media_notice: '为保护现场隐私，导出仅含媒体元数据，不包含图片二进制。',
  });
});

privacyRouter.delete('/account', async (c) => {
  const installationId = c.get('installationId');
  const mediaRows = await db.select().from(evidenceMedia).where(eq(evidenceMedia.installationId, installationId));
  try {
    for (const media of mediaRows) await removeEvidenceFile(media.storagePath);
  } catch {
    return fail(c, 503, 'ACCOUNT_MEDIA_CLEANUP_FAILED', '账户媒体暂时无法完全删除，请稍后重试', { retryable: true, retry_after_ms: 5_000 });
  }
  await revokeUserSessions(installationId);
  await db.delete(installationAccounts).where(eq(installationAccounts.id, installationId));
  return ok(c, {
    deleted: true,
    media_deleted: mediaRows.length,
    notice: '匿名账户、会话和可归属数据已删除；已去标识化的最小共识审计记录按隐私政策保留。',
  });
});
