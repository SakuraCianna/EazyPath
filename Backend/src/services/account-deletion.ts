import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { revokeUserSessions } from '../auth/tokens.js';
import {
  auditEvents,
  communityReviewTasks,
  communityReviewVotes,
  db,
  evidenceMedia,
  installationAccounts,
  installationChallenges,
  mediaUploadSessions,
  observations,
  userFeedback,
} from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { toPublicConsensusSnapshot } from '../domain/consensus.js';
import { recomputeCommunityConsensus } from './community-consensus.js';
import { removeEvidenceFile, removeUploadDirectory } from './media-storage.js';

interface AccountDeletionStart {
  observationsWithdrawn: number;
  feedbackDeleted: number;
}

interface AccountMediaReference {
  id: string;
  storagePath: string;
}

interface AccountDeletionFinalized {
  kind: 'deleted';
}

interface AccountDeletionCleanupRequired {
  kind: 'cleanup_required';
}

type AccountDeletionFinalization = AccountDeletionFinalized | AccountDeletionCleanupRequired;
const ACTIVE_COMMUNITY_REVIEW_STATUSES = ['pending_review', 'community_consensus', 'conflicting'] as const;

export interface AccountDeletionDependencies {
  beginDeletion: (installationId: string) => Promise<AccountDeletionStart | null>;
  revokeSessions: (installationId: string) => Promise<void>;
  listUploadIds: (installationId: string) => Promise<string[]>;
  listMedia: (installationId: string) => Promise<AccountMediaReference[]>;
  removeUpload: (uploadId: string) => Promise<void>;
  removeMedia: (storagePath: string) => Promise<void>;
  markMediaDeleted: (installationId: string, mediaId: string) => Promise<void>;
  finalizeDeletion: (
    installationId: string,
    uploadIds: string[],
  ) => Promise<AccountDeletionFinalization>;
}

export interface AccountDeletionResult {
  mediaDeleted: number;
  uploadSessionsDeleted: number;
  observationsWithdrawn: number;
  feedbackDeleted: number;
}

export class AccountDeletionError extends Error {
  constructor(readonly code: 'ACCOUNT_MEDIA_CLEANUP_FAILED' | 'ACCOUNT_MEDIA_CLEANUP_INCOMPLETE') {
    super(code);
  }
}

export async function deleteInstallationAccount(
  installationId: string,
  dependencies: AccountDeletionDependencies = productionDependencies,
): Promise<AccountDeletionResult | null> {
  const account = await dependencies.beginDeletion(installationId);
  if (!account) return null;
  await dependencies.revokeSessions(installationId);
  const [uploadIds, mediaRows] = await Promise.all([
    dependencies.listUploadIds(installationId),
    dependencies.listMedia(installationId),
  ]);
  try {
    for (const uploadId of uploadIds) await dependencies.removeUpload(uploadId);
    for (const media of mediaRows) {
      await dependencies.removeMedia(media.storagePath);
      await dependencies.markMediaDeleted(installationId, media.id);
    }
  } catch {
    throw new AccountDeletionError('ACCOUNT_MEDIA_CLEANUP_FAILED');
  }
  const finalized = await dependencies.finalizeDeletion(
    installationId,
    uploadIds,
  );
  if (finalized.kind === 'cleanup_required') {
    throw new AccountDeletionError('ACCOUNT_MEDIA_CLEANUP_INCOMPLETE');
  }
  return {
    mediaDeleted: mediaRows.length,
    uploadSessionsDeleted: uploadIds.length,
    observationsWithdrawn: account.observationsWithdrawn,
    feedbackDeleted: account.feedbackDeleted,
  };
}

export async function cleanupDeletingAccounts(): Promise<void> {
  const accounts = await db.select({ id: installationAccounts.id })
    .from(installationAccounts)
    .where(eq(installationAccounts.status, 'deleting'));
  for (const account of accounts) {
    try {
      await deleteInstallationAccount(account.id);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'privacy.account_cleanup_failed',
        accountRiskKey: sha256(account.id).slice(0, 16),
        code: error instanceof AccountDeletionError ? error.code : 'ACCOUNT_DELETE_FAILED',
      }));
    }
  }
}

const productionDependencies: AccountDeletionDependencies = {
  async beginDeletion(installationId) {
    return db.transaction(async (tx) => {
      const [current] = await tx.select({
        installationGuid: installationAccounts.installationGuid,
        status: installationAccounts.status,
      }).from(installationAccounts)
        .where(eq(installationAccounts.id, installationId))
        .for('update')
        .limit(1);
      if (!current) return null;
      if (current.status !== 'deleting') {
        await tx.update(installationAccounts).set({ status: 'deleting', updatedAt: new Date() })
          .where(eq(installationAccounts.id, installationId));
      }
      const now = new Date();
      const affectedVoteRows = await tx.selectDistinct({ taskId: communityReviewVotes.reviewTaskId })
        .from(communityReviewVotes)
        .innerJoin(communityReviewTasks, eq(communityReviewVotes.reviewTaskId, communityReviewTasks.id))
        .where(and(
          eq(communityReviewVotes.installationId, installationId),
          inArray(communityReviewTasks.status, ACTIVE_COMMUNITY_REVIEW_STATUSES),
        ));
      const affectedTaskIds = affectedVoteRows.map((row) => row.taskId);
      const affectedTasks = affectedTaskIds.length === 0 ? [] : await tx.select().from(communityReviewTasks)
        .where(and(
          inArray(communityReviewTasks.id, affectedTaskIds),
          inArray(communityReviewTasks.status, ACTIVE_COMMUNITY_REVIEW_STATUSES),
        ))
        .orderBy(asc(communityReviewTasks.id))
        .for('update');
      const observationRows = await tx.select({ id: observations.id }).from(observations)
        .where(and(
          eq(observations.installationId, installationId),
          eq(observations.evidenceSource, 'community'),
        ));
      await tx.update(observations).set({
        moderationStatus: 'withdrawn',
        moderationReason: '匿名账户已删除，证据停止公开',
        moderationVersion: sql`${observations.moderationVersion} + 1`,
        evidenceGrade: 'U',
        appealUntil: null,
        withdrawnAt: now,
        updatedAt: now,
      }).where(and(
        eq(observations.installationId, installationId),
        eq(observations.evidenceSource, 'community'),
        isNull(observations.withdrawnAt),
      ));
      await tx.update(communityReviewVotes).set({ suspended: true, updatedAt: now })
        .where(eq(communityReviewVotes.installationId, installationId));
      for (const task of affectedTasks) {
        const result = await recomputeCommunityConsensus(tx, task.id);
        await tx.update(communityReviewTasks).set({
          status: result.status,
          consensusOutcome: result.outcome,
          consensusSnapshot: toPublicConsensusSnapshot(result),
          updatedAt: now,
        }).where(eq(communityReviewTasks.id, task.id));
        if (task.targetType === 'observation') {
          const [latestTask] = await tx.select({ id: communityReviewTasks.id }).from(communityReviewTasks)
            .where(and(
              eq(communityReviewTasks.targetType, 'observation'),
              eq(communityReviewTasks.targetId, task.targetId),
            ))
            .orderBy(desc(communityReviewTasks.createdAt), desc(communityReviewTasks.id))
            .limit(1);
          if (latestTask?.id === task.id) {
            const latestEligibleVoteAt = result.votes
              .filter((vote) => !vote.suspended)
              .reduce((latest, vote) => Math.max(latest, vote.submittedAt.getTime()), 0);
            const evidenceExpiresAt = new Date(latestEligibleVoteAt + 90 * 24 * 60 * 60 * 1000);
            const remainsCurrent = result.status === 'community_consensus'
              && result.outcome === 'present'
              && latestEligibleVoteAt > 0
              && evidenceExpiresAt > now;
            await tx.update(observations).set({
              freshnessStatus: remainsCurrent ? 'current' : result.status === 'conflicting' ? 'conflicting' : 'expired',
              evidenceGrade: remainsCurrent ? 'B' : 'U',
              expiresAt: remainsCurrent ? evidenceExpiresAt : now,
              updatedAt: now,
            }).where(and(
              eq(observations.id, task.targetId),
              eq(observations.moderationStatus, 'approved'),
              isNull(observations.withdrawnAt),
            ));
          }
        }
        await tx.insert(auditEvents).values({
          actorType: 'system',
          action: 'community_review.vote_suspended_for_privacy',
          targetType: 'community_review_task',
          targetId: task.id,
          metadata: { status: result.status, outcome: result.outcome },
        });
      }
      const deletedFeedback = await tx.delete(userFeedback)
        .where(eq(userFeedback.installationId, installationId))
        .returning({ id: userFeedback.id });
      await tx.delete(installationChallenges)
        .where(eq(installationChallenges.installationGuid, current.installationGuid));
      await tx.update(auditEvents).set({ actorId: null }).where(and(
        eq(auditEvents.actorType, 'installation'),
        eq(auditEvents.actorId, installationId),
      ));
      return {
        observationsWithdrawn: observationRows.length,
        feedbackDeleted: deletedFeedback.length,
      };
    });
  },
  revokeSessions: revokeUserSessions,
  async listUploadIds(installationId) {
    const rows = await db.select({ id: mediaUploadSessions.id }).from(mediaUploadSessions)
      .where(eq(mediaUploadSessions.installationId, installationId));
    return rows.map((row) => row.id);
  },
  async listMedia(installationId) {
    return db.select({ id: evidenceMedia.id, storagePath: evidenceMedia.storagePath }).from(evidenceMedia)
      .where(eq(evidenceMedia.installationId, installationId));
  },
  removeUpload: removeUploadDirectory,
  removeMedia: removeEvidenceFile,
  async markMediaDeleted(installationId, mediaId) {
    const now = new Date();
    await db.update(evidenceMedia).set({
      status: 'deleted',
      fingerprintHmac: null,
      fingerprintKeyVersion: null,
      deletedAt: now,
      updatedAt: now,
    }).where(and(
      eq(evidenceMedia.id, mediaId),
      eq(evidenceMedia.installationId, installationId),
    ));
  },
  async finalizeDeletion(installationId, uploadIds) {
    return db.transaction(async (tx) => {
      const [current] = await tx.select({ id: installationAccounts.id })
        .from(installationAccounts)
        .where(eq(installationAccounts.id, installationId))
        .for('update')
        .limit(1);
      if (!current) {
        return { kind: 'deleted' };
      }
      const remainingMedia = await tx.select({ id: evidenceMedia.id }).from(evidenceMedia).where(and(
        eq(evidenceMedia.installationId, installationId),
        or(isNull(evidenceMedia.deletedAt), isNotNull(evidenceMedia.fingerprintHmac), isNotNull(evidenceMedia.fingerprintKeyVersion)),
      )).limit(1);
      if (remainingMedia.length > 0) return { kind: 'cleanup_required' };
      if (uploadIds.length > 0) {
        await tx.delete(mediaUploadSessions).where(and(
          eq(mediaUploadSessions.installationId, installationId),
          inArray(mediaUploadSessions.id, uploadIds),
        ));
      }
      const remainingUploads = await tx.select({ id: mediaUploadSessions.id }).from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.installationId, installationId))
        .limit(1);
      if (remainingUploads.length > 0) return { kind: 'cleanup_required' };
      await tx.insert(auditEvents).values({
        actorType: 'system',
        action: 'installation.deleted',
        targetType: 'installation_account',
        metadata: {
          upload_session_count: uploadIds.length,
        },
      });
      await tx.delete(installationAccounts).where(eq(installationAccounts.id, installationId));
      return { kind: 'deleted' };
    });
  },
};
