import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { getEnv } from '../config/env.js';
import {
  communityReviewTasks,
  db,
  evidenceMedia,
  mediaUploadSessions,
  observationMedia,
  observations,
  verificationRecords,
} from '../db/index.js';
import { removeEvidenceFile, removeUploadDirectory } from './media-storage.js';

export async function cleanupExpiredMedia(): Promise<void> {
  const now = new Date();
  await cleanupTemporaryVerificationFiles(now);

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

  const expiredEvidence = await db.select().from(evidenceMedia).where(and(lte(evidenceMedia.expiresAt, now), isNull(evidenceMedia.deletedAt)));
  const removedEvidenceIds: string[] = [];
  for (const media of expiredEvidence) {
    try {
      await removeEvidenceFile(media.storagePath);
      removedEvidenceIds.push(media.id);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'media.evidence_cleanup_failed', mediaId: media.id, message: error instanceof Error ? error.message : 'unknown' }));
    }
  }
  if (removedEvidenceIds.length > 0) {
    await db.update(evidenceMedia).set({ status: 'deleted', deletedAt: now, updatedAt: now }).where(inArray(evidenceMedia.id, removedEvidenceIds));
  }
  await db.update(verificationRecords).set({ imageFingerprintHmac: null, fingerprintKeyVersion: null, fingerprintExpiresAt: null, updatedAt: now }).where(lte(verificationRecords.fingerprintExpiresAt, now));
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
