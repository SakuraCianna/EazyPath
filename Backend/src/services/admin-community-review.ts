import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  auditEvents,
  communityReviewTasks,
  communityReviewVotes,
  db,
  evidenceMedia,
  featureDefinitions,
  observations,
  places,
} from '../db/index.js';
import { sanitizeStoredConsensusSnapshot } from '../domain/consensus.js';

export type CommunityReviewAdminAction = 'reopen' | 'reject' | 'cancel';
export type CommunityReviewAdminResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

interface ListInput {
  page: number;
  pageSize: number;
  query?: string;
  status?: 'pending_review' | 'community_consensus' | 'conflicting' | 'admin_rejected' | 'cancelled' | 'reopened';
}

const taskProjection = {
  id: communityReviewTasks.id,
  placeId: communityReviewTasks.placeId,
  placeName: places.name,
  placeAddress: places.address,
  targetType: communityReviewTasks.targetType,
  targetId: communityReviewTasks.targetId,
  featureKey: featureDefinitions.featureKey,
  featureName: featureDefinitions.displayName,
  status: communityReviewTasks.status,
  reason: communityReviewTasks.reason,
  consensusOutcome: communityReviewTasks.consensusOutcome,
  consensusSnapshot: communityReviewTasks.consensusSnapshot,
  locationRadiusMeters: communityReviewTasks.locationRadiusMeters,
  closesAt: communityReviewTasks.closesAt,
  resolutionReason: communityReviewTasks.resolutionReason,
  resolvedAt: communityReviewTasks.resolvedAt,
  supersededByTaskId: communityReviewTasks.supersededByTaskId,
  createdAt: communityReviewTasks.createdAt,
  updatedAt: communityReviewTasks.updatedAt,
  observationValue: observations.valueJson,
  observationGrade: observations.evidenceGrade,
  observationFreshness: observations.freshnessStatus,
  observationExpiresAt: observations.expiresAt,
  observationObservedAt: observations.observedAt,
  voteCount: sql<number>`(SELECT COUNT(*) FROM community_review_votes v WHERE v.review_task_id = ${communityReviewTasks.id})`.mapWith(Number),
  locatedVoteCount: sql<number>`(SELECT COUNT(*) FROM community_review_votes v WHERE v.review_task_id = ${communityReviewTasks.id} AND v.location_proof_passed = true)`.mapWith(Number),
  mediaVoteCount: sql<number>`(SELECT COUNT(*) FROM community_review_votes v WHERE v.review_task_id = ${communityReviewTasks.id} AND v.base_weight > 0.5)`.mapWith(Number),
};

export async function listAdminCommunityReviews(input: ListInput) {
  const search = input.query ? `%${input.query}%` : undefined;
  const condition = and(
    input.status ? eq(communityReviewTasks.status, input.status) : undefined,
    search ? or(
      ilike(places.name, search),
      ilike(places.address, search),
      ilike(featureDefinitions.featureKey, search),
      ilike(featureDefinitions.displayName, search),
    ) : undefined,
  );
  const base = () => db.select(taskProjection).from(communityReviewTasks)
    .innerJoin(places, eq(communityReviewTasks.placeId, places.id))
    .innerJoin(featureDefinitions, eq(communityReviewTasks.featureDefinitionId, featureDefinitions.id))
    .leftJoin(observations, and(eq(communityReviewTasks.targetType, 'observation'), eq(communityReviewTasks.targetId, observations.id)));
  const [items, [total], [summary]] = await Promise.all([
    base().where(condition).orderBy(desc(communityReviewTasks.updatedAt), desc(communityReviewTasks.id))
      .limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: sql<number>`count(*)`.mapWith(Number) }).from(communityReviewTasks)
      .innerJoin(places, eq(communityReviewTasks.placeId, places.id))
      .innerJoin(featureDefinitions, eq(communityReviewTasks.featureDefinitionId, featureDefinitions.id))
      .where(condition),
    db.select({
      pending: sql<number>`count(*) FILTER (WHERE ${communityReviewTasks.status} = 'pending_review')`.mapWith(Number),
      conflicting: sql<number>`count(*) FILTER (WHERE ${communityReviewTasks.status} = 'conflicting')`.mapWith(Number),
      consensus: sql<number>`count(*) FILTER (WHERE ${communityReviewTasks.status} = 'community_consensus')`.mapWith(Number),
      resolved: sql<number>`count(*) FILTER (WHERE ${communityReviewTasks.status} IN ('admin_rejected', 'cancelled', 'reopened'))`.mapWith(Number),
    }).from(communityReviewTasks),
  ]);
  return {
    items: items.map(sanitizeTask),
    total: total?.value ?? 0,
    page: input.page,
    pageSize: input.pageSize,
    summary: summary ?? { pending: 0, conflicting: 0, consensus: 0, resolved: 0 },
  };
}

export async function getAdminCommunityReview(taskId: string) {
  const [task] = await db.select(taskProjection).from(communityReviewTasks)
    .innerJoin(places, eq(communityReviewTasks.placeId, places.id))
    .innerJoin(featureDefinitions, eq(communityReviewTasks.featureDefinitionId, featureDefinitions.id))
    .leftJoin(observations, and(eq(communityReviewTasks.targetType, 'observation'), eq(communityReviewTasks.targetId, observations.id)))
    .where(eq(communityReviewTasks.id, taskId)).limit(1);
  if (!task) return undefined;
  const votes = await db.select({
    answer: communityReviewVotes.answer,
    mediaId: communityReviewVotes.mediaId,
    baseWeight: communityReviewVotes.baseWeight,
    finalWeight: communityReviewVotes.finalWeight,
    hasMedia: sql<boolean>`${communityReviewVotes.baseWeight} > 0.5`,
    locationProofPassed: communityReviewVotes.locationProofPassed,
    locationDistanceBucket: communityReviewVotes.locationDistanceBucket,
    suspended: communityReviewVotes.suspended,
    createdAt: communityReviewVotes.createdAt,
    updatedAt: communityReviewVotes.updatedAt,
  }).from(communityReviewVotes).where(eq(communityReviewVotes.reviewTaskId, task.id)).orderBy(desc(communityReviewVotes.updatedAt));
  return { task: sanitizeTask(task), votes };
}

export async function getAdminCommunityReviewMedia(mediaId: string) {
  const [media] = await db.select({
    id: evidenceMedia.id,
    storagePath: evidenceMedia.storagePath,
    mimeType: evidenceMedia.mimeType,
    byteSize: evidenceMedia.byteSize,
    reviewTaskId: communityReviewVotes.reviewTaskId,
  }).from(evidenceMedia)
    .innerJoin(communityReviewVotes, eq(evidenceMedia.id, communityReviewVotes.mediaId))
    .where(and(
      eq(evidenceMedia.id, mediaId),
      eq(evidenceMedia.status, 'linked'),
      eq(evidenceMedia.redactionConfirmed, true),
      isNull(evidenceMedia.deletedAt),
    ))
    .limit(1);
  return media ?? null;
}

export async function auditAdminCommunityReviewMediaAccess(input: {
  actorId: string;
  mediaId: string;
  reviewTaskId: string;
  requestId: string;
}): Promise<void> {
  await db.insert(auditEvents).values({
    actorType: 'admin',
    actorId: input.actorId,
    action: 'community_review.media_viewed',
    targetType: 'community_review_task',
    targetId: input.reviewTaskId,
    metadata: { media_id: input.mediaId },
    requestId: input.requestId,
  });
}

export async function decideAdminCommunityReview(input: {
  actorId: string;
  taskId: string;
  expectedUpdatedAt: Date;
  action: CommunityReviewAdminAction;
  reason: string;
  requestId: string;
}): Promise<CommunityReviewAdminResult<{ id: string; status: string; updatedAt: Date; newTaskId?: string }>> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(communityReviewTasks)
      .where(eq(communityReviewTasks.id, input.taskId)).for('update').limit(1);
    if (!task) return failure('COMMUNITY_REVIEW_NOT_FOUND', '社区复核任务不存在');
    if (task.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      return failure('COMMUNITY_REVIEW_CONFLICT', '任务已被其他管理员或新投票更新，请刷新后重试');
    }
    const allowed = input.action === 'reopen'
      ? ['conflicting', 'admin_rejected'].includes(task.status)
      : ['pending_review', 'conflicting'].includes(task.status);
    if (!allowed) return failure('COMMUNITY_REVIEW_ACTION_FORBIDDEN', '当前任务状态不允许执行该操作');
    const now = new Date();
    let newTaskId: string | undefined;
    let nextStatus: string;
    if (input.action === 'reopen') {
      const [newTask] = await tx.insert(communityReviewTasks).values({
        placeId: task.placeId,
        targetType: task.targetType,
        targetId: task.targetId,
        featureDefinitionId: task.featureDefinitionId,
        status: 'pending_review',
        reason: 'admin_reopened',
        locationRadiusMeters: task.locationRadiusMeters,
      }).returning({ id: communityReviewTasks.id });
      if (!newTask) throw new Error('COMMUNITY_REVIEW_REOPEN_FAILED');
      newTaskId = newTask.id;
      nextStatus = 'reopened';
    } else {
      nextStatus = input.action === 'reject' ? 'admin_rejected' : 'cancelled';
    }
    const [updated] = await tx.update(communityReviewTasks).set({
      status: nextStatus,
      consensusOutcome: input.action === 'reject' ? null : task.consensusOutcome,
      resolutionReason: input.reason,
      resolvedByAdminId: input.actorId,
      resolvedAt: now,
      supersededByTaskId: newTaskId,
      updatedAt: now,
    }).where(eq(communityReviewTasks.id, task.id)).returning({
      id: communityReviewTasks.id,
      status: communityReviewTasks.status,
      updatedAt: communityReviewTasks.updatedAt,
    });
    if (!updated) throw new Error('COMMUNITY_REVIEW_UPDATE_FAILED');
    if (input.action === 'reject' && task.targetType === 'observation') {
      await tx.update(observations).set({ freshnessStatus: 'expired', evidenceGrade: 'U', expiresAt: now, updatedAt: now })
        .where(and(eq(observations.id, task.targetId), eq(observations.moderationStatus, 'approved'), sql`${observations.withdrawnAt} IS NULL`));
    }
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: `community_review.${input.action}`,
      targetType: 'community_review_task', targetId: task.id, reason: input.reason,
      metadata: { before_status: task.status, after_status: nextStatus, new_task_id: newTaskId ?? null }, requestId: input.requestId,
    });
    return { ok: true, value: { ...updated, ...(newTaskId ? { newTaskId } : {}) } };
  });
}

function failure(code: string, message: string) {
  return { ok: false as const, code, message };
}

function sanitizeTask<T extends { consensusSnapshot: unknown }>(task: T): T {
  return {
    ...task,
    consensusSnapshot: sanitizeStoredConsensusSnapshot(task.consensusSnapshot),
  };
}
