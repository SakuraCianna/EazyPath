import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getEnv } from '../config/env.js';
import {
  auditEvents,
  communityReviewTasks,
  db,
  evidenceMedia,
  mediaUploadSessions,
  observationMedia,
  observations,
  userFeedback,
  verificationRecords,
} from '../db/index.js';
import { REJECTED_EVIDENCE_RETENTION_MS } from '../domain/moderation.js';
import { removeEvidenceFile, removeUploadDirectory } from './media-storage.js';
import { cleanupDeletingAccounts } from './account-deletion.js';

export async function cleanupExpiredMedia(): Promise<void> {
  const now = new Date();
  await cleanupTemporaryVerificationFiles(now);
  await cleanupDeletingAccounts();
  await expireFeedbackRequests(now);

  const expiredUploads = await db.select().from(mediaUploadSessions).where(and(eq(mediaUploadSessions.status, 'uploading'), lte(mediaUploadSessions.expiresAt, now)));
  const removedUploadIds: string[] = [];
  for (const upload of expiredUploads) {
    try {
      await removeUploadDirectory(upload.id);
      removedUploadIds.push(upload.id);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'media.upload_cleanup_failed', uploadId: upload.id, message: error instanceof Error ? error.message : 'unknown' }));
    }
  }
  if (removedUploadIds.length > 0) await db.delete(mediaUploadSessions).where(inArray(mediaUploadSessions.id, removedUploadIds));

  const expiredEvidence = await db.select({ id: evidenceMedia.id }).from(evidenceMedia)
    .where(and(lte(evidenceMedia.expiresAt, now), isNull(evidenceMedia.deletedAt)));
  for (const candidate of expiredEvidence) {
    try {
      await db.transaction(async (tx) => {
        const [media] = await tx.select().from(evidenceMedia).where(and(
          eq(evidenceMedia.id, candidate.id),
          lte(evidenceMedia.expiresAt, now),
          isNull(evidenceMedia.deletedAt),
        )).for('update').limit(1);
        if (!media) return;
        await removeEvidenceFile(media.storagePath);
        await tx.update(evidenceMedia).set({
          status: 'deleted',
          fingerprintHmac: null,
          fingerprintKeyVersion: null,
          deletedAt: now,
          updatedAt: now,
        })
          .where(and(eq(evidenceMedia.id, media.id), isNull(evidenceMedia.deletedAt)));
      });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'media.evidence_cleanup_failed', mediaId: candidate.id, message: error instanceof Error ? error.message : 'unknown' }));
    }
  }
  await db.update(verificationRecords).set({ imageFingerprintHmac: null, fingerprintKeyVersion: null, fingerprintExpiresAt: null, updatedAt: now }).where(lte(verificationRecords.fingerprintExpiresAt, now));
}

async function expireFeedbackRequests(now: Date): Promise<void> {
  const expired = await db.select({ id: userFeedback.id, targetId: userFeedback.targetId }).from(userFeedback).where(and(
    eq(userFeedback.targetType, 'observation'),
    inArray(userFeedback.feedbackType, ['appeal', 'supplement_request']),
    inArray(userFeedback.status, ['open', 'in_review']),
    lte(userFeedback.expiresAt, now),
  ));
  for (const reference of expired) {
    await db.transaction(async (tx) => {
      const [observation] = await tx.select().from(observations)
        .where(eq(observations.id, reference.targetId))
        .for('update')
        .limit(1);
      const [feedback] = await tx.select().from(userFeedback).where(and(
        eq(userFeedback.id, reference.id),
        inArray(userFeedback.status, ['open', 'in_review']),
        lte(userFeedback.expiresAt, now),
      )).for('update').limit(1);
      if (!feedback) return;
      if (!observation) {
        await tx.update(userFeedback).set({
          status: 'withdrawn',
          resolutionReason: '关联观测已删除，反馈自动结案',
          resolvedAt: now,
          updatedAt: now,
        }).where(eq(userFeedback.id, feedback.id));
        await tx.insert(auditEvents).values({
          actorType: 'system',
          action: 'user_feedback.expired',
          targetType: 'observation',
          targetId: reference.targetId,
          reason: '关联观测已删除',
          metadata: { feedback_id: feedback.id, feedback_type: feedback.feedbackType },
        });
        return;
      }

      const mediaLinks = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia)
        .where(eq(observationMedia.observationId, observation.id));
      if (feedback.feedbackType === 'appeal') {
        await tx.update(userFeedback).set({
          status: 'rejected',
          resolutionReason: '申诉处理期限已结束，系统自动结案',
          resolvedAt: now,
          updatedAt: now,
        }).where(eq(userFeedback.id, feedback.id));
        if (mediaLinks.length > 0) {
          await tx.update(evidenceMedia).set({ status: 'rejected', expiresAt: now, updatedAt: now }).where(and(
            inArray(evidenceMedia.id, mediaLinks.map((item) => item.mediaId)),
            isNull(evidenceMedia.deletedAt),
          ));
        }
      } else {
        const appealUntil = new Date(now.getTime() + REJECTED_EVIDENCE_RETENTION_MS);
        await tx.update(userFeedback).set({
          status: 'withdrawn',
          resolutionReason: '补充资料期限已结束，系统自动结案',
          resolvedAt: now,
          updatedAt: now,
        }).where(eq(userFeedback.id, feedback.id));
        await tx.update(observations).set({
          moderationStatus: 'rejected',
          moderationReason: '未在期限内补充资料',
          moderationVersion: sql`${observations.moderationVersion} + 1`,
          moderatedAt: now,
          appealUntil,
          evidenceGrade: 'U',
          updatedAt: now,
        }).where(eq(observations.id, observation.id));
        if (mediaLinks.length > 0) {
          await tx.update(evidenceMedia).set({ status: 'rejected', expiresAt: appealUntil, updatedAt: now }).where(and(
            inArray(evidenceMedia.id, mediaLinks.map((item) => item.mediaId)),
            isNull(evidenceMedia.deletedAt),
          ));
        }
      }
      await tx.insert(auditEvents).values({
        actorType: 'system',
        action: 'user_feedback.expired',
        targetType: 'observation',
        targetId: observation.id,
        reason: feedback.feedbackType === 'appeal' ? '申诉处理期限结束' : '补充资料期限结束',
        metadata: { feedback_id: feedback.id, feedback_type: feedback.feedbackType },
      });
    });
  }
}

export async function expireEvidenceAndCreateReviews(): Promise<void> {
  const now = new Date();
  const expired = await db.select().from(observations).where(and(eq(observations.freshnessStatus, 'current'), lte(observations.expiresAt, now), isNull(observations.withdrawnAt)));
  for (const observation of expired) {
    await db.transaction(async (tx) => {
      await tx.update(observations).set({ freshnessStatus: 'expired', evidenceGrade: 'U', updatedAt: now }).where(eq(observations.id, observation.id));
      const [existing] = await tx.select({ id: communityReviewTasks.id }).from(communityReviewTasks).where(and(eq(communityReviewTasks.targetType, 'observation'), eq(communityReviewTasks.targetId, observation.id), eq(communityReviewTasks.status, 'pending_review'))).limit(1);
      if (!existing) {
        await tx.insert(communityReviewTasks).values({
          placeId: observation.placeId,
          targetType: 'observation',
          targetId: observation.id,
          featureDefinitionId: observation.featureDefinitionId,
          reason: 'evidence_expired',
          status: 'pending_review',
        });
      }
      const mediaLinks = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia).where(eq(observationMedia.observationId, observation.id));
      if (mediaLinks.length > 0) {
        await tx.update(evidenceMedia).set({ expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), updatedAt: now }).where(inArray(evidenceMedia.id, mediaLinks.map((link) => link.mediaId)));
      }
    });
  }
}

async function cleanupTemporaryVerificationFiles(now: Date): Promise<void> {
  const root = path.resolve(getEnv().MEDIA_TEMP_DIR);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const target = path.join(root, entry.name);
    const metadata = await stat(target);
    if (now.getTime() - metadata.mtimeMs > 10 * 60 * 1000) await rm(target, { force: true });
  }
}
