import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  aiProcessingConsents,
  agentTasks,
  communityReviewVotes,
  db,
  evidenceMedia,
  observations,
  userFeedback,
  userProfiles,
} from '../db/index.js';
import { AI_CONSENT_POLICY_VERSION, AiCapabilitySchema } from '../domain/ai-consent.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser, requireUserForAccountDeletion } from '../middleware/auth.js';
import { taskReadSelection } from '../repositories/taskRepository.js';
import { AccountDeletionError, deleteInstallationAccount } from '../services/account-deletion.js';
import { AiConsentVersionConflictError, listAiConsents, setAiConsent } from '../services/ai-consent.js';
import type { AppBindings } from '../types.js';

export const privacyRouter = new Hono<AppBindings>();

const consentUpdateSchema = z.object({
  granted: z.boolean(),
  policy_version: z.string().min(1).max(32),
  expected_version: z.number().int().positive().nullable(),
});

privacyRouter.get('/ai-consents', requireUser, async (c) => {
  c.header('cache-control', 'no-store');
  return ok(c, {
    policy_version: AI_CONSENT_POLICY_VERSION,
    consents: await listAiConsents(c.get('installationId')),
  });
});

privacyRouter.put('/ai-consents/:capability', requireUser, async (c) => {
  const capability = AiCapabilitySchema.safeParse(c.req.param('capability'));
  if (!capability.success) return fail(c, 404, 'AI_CAPABILITY_NOT_FOUND', 'AI 能力不存在');
  const body = consentUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return fail(c, 422, 'VALIDATION_ERROR', '同意状态或政策版本无效');
  if (body.data.granted && body.data.policy_version !== AI_CONSENT_POLICY_VERSION) {
    return fail(c, 409, 'AI_CONSENT_POLICY_STALE', '隐私说明已更新，请阅读最新版本后重新选择', {
      retryable: false,
      details: { policy_version: AI_CONSENT_POLICY_VERSION },
    });
  }
  c.header('cache-control', 'no-store');
  try {
    return ok(c, await setAiConsent(
      c.get('installationId'),
      capability.data,
      body.data.granted,
      body.data.expected_version,
    ));
  } catch (error) {
    if (error instanceof AiConsentVersionConflictError) {
      return fail(c, 409, 'AI_CONSENT_VERSION_CONFLICT', '同意状态已在其他页面更新，请刷新后重试', { retryable: false });
    }
    throw error;
  }
});

privacyRouter.get('/export', requireUser, async (c) => {
  const installationId = c.get('installationId');
  const [profile, tasks, observationRows, votes, feedback, media, aiConsents] = await Promise.all([
    db.select().from(userProfiles).where(eq(userProfiles.installationId, installationId)),
    db.select(taskReadSelection).from(agentTasks).where(eq(agentTasks.installationId, installationId)),
    db.select().from(observations).where(eq(observations.installationId, installationId)),
    db.select().from(communityReviewVotes).where(eq(communityReviewVotes.installationId, installationId)),
    db.select({
      id: userFeedback.id,
      feedbackType: userFeedback.feedbackType,
      sourceType: userFeedback.sourceType,
      targetType: userFeedback.targetType,
      targetId: userFeedback.targetId,
      message: userFeedback.message,
      status: userFeedback.status,
      resolutionReason: userFeedback.resolutionReason,
      expiresAt: userFeedback.expiresAt,
      resolvedAt: userFeedback.resolvedAt,
      createdAt: userFeedback.createdAt,
      updatedAt: userFeedback.updatedAt,
    }).from(userFeedback).where(eq(userFeedback.installationId, installationId)),
    db.select({
      id: evidenceMedia.id,
      mimeType: evidenceMedia.mimeType,
      byteSize: evidenceMedia.byteSize,
      width: evidenceMedia.width,
      height: evidenceMedia.height,
      status: evidenceMedia.status,
      linkedAt: evidenceMedia.linkedAt,
      expiresAt: evidenceMedia.expiresAt,
      deletedAt: evidenceMedia.deletedAt,
      createdAt: evidenceMedia.createdAt,
      updatedAt: evidenceMedia.updatedAt,
    }).from(evidenceMedia).where(eq(evidenceMedia.installationId, installationId)),
    db.select({
      capability: aiProcessingConsents.capability,
      policyVersion: aiProcessingConsents.policyVersion,
      processor: aiProcessingConsents.processor,
      region: aiProcessingConsents.region,
      noticeVerifiedAt: aiProcessingConsents.noticeVerifiedAt,
      grantedAt: aiProcessingConsents.grantedAt,
      revokedAt: aiProcessingConsents.revokedAt,
      version: aiProcessingConsents.version,
      createdAt: aiProcessingConsents.createdAt,
      updatedAt: aiProcessingConsents.updatedAt,
    }).from(aiProcessingConsents).where(eq(aiProcessingConsents.installationId, installationId)),
  ]);
  c.header('content-disposition', `attachment; filename="eazypath-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return ok(c, {
    exported_at: new Date().toISOString(),
    profile,
    tasks,
    observations: observationRows,
    community_review_votes: votes,
    feedback,
    media,
    ai_processing_consents: aiConsents,
    media_notice: '为保护现场隐私，导出仅含媒体元数据，不包含图片二进制。',
  });
});

privacyRouter.delete('/account', requireUserForAccountDeletion, async (c) => {
  const installationId = c.get('installationId');
  try {
    const result = await deleteInstallationAccount(installationId);
    if (!result) return fail(c, 404, 'ACCOUNT_NOT_FOUND', '匿名账户不存在');
    return ok(c, {
      deleted: true,
      media_deleted: result.mediaDeleted,
      upload_sessions_deleted: result.uploadSessionsDeleted,
      observations_withdrawn: result.observationsWithdrawn,
      feedback_deleted: result.feedbackDeleted,
      notice: '匿名账户、会话、上传暂存、反馈正文及媒体指纹已删除；社区观测已停止公开并仅保留去标识化的最小审计字段。',
    });
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      return fail(c, 503, error.code, '账户数据暂时无法完全删除，后台清理会继续重试', { retryable: true, retry_after_ms: 5_000 });
    }
    throw error;
  }
});
