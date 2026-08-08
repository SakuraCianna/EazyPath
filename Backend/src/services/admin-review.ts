import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  FEEDBACK_RESPONSE_WINDOW_MS,
  planObservationModeration,
  type EvidenceGrade,
  type ObservationModerationDecision,
  type ObservationModerationStatus,
} from '../domain/moderation.js';
import {
  auditEvents,
  db,
  evidenceMedia,
  facilities,
  featureDefinitions,
  installationAccounts,
  observationMedia,
  observations,
  places,
  placeUnits,
  userFeedback,
  verificationRecords,
} from '../db/index.js';

type ReviewFailureCode =
  | 'OBSERVATION_NOT_FOUND'
  | 'OBSERVATION_REVIEW_CONFLICT'
  | 'OBSERVATION_REVIEW_FORBIDDEN'
  | 'APPEAL_NOT_FOUND'
  | 'APPEAL_REVIEW_CONFLICT'
  | 'VERIFICATION_NOT_FOUND'
  | 'VERIFICATION_REVIEW_CONFLICT';

export type ReviewResult<T> = { ok: true; value: T } | { ok: false; code: ReviewFailureCode; message: string };

export async function listObservationReviews(input: {
  status?: ObservationModerationStatus;
  limit: number;
  offset: number;
}) {
  const condition = and(
    eq(observations.evidenceSource, 'community'),
    eq(observations.moderationStatus, input.status ?? 'pending'),
  );
  const [items, totals] = await Promise.all([
    db.select({
      id: observations.id,
      moderationStatus: observations.moderationStatus,
      moderationReason: observations.moderationReason,
      moderationVersion: observations.moderationVersion,
      evidenceGrade: observations.evidenceGrade,
      evidenceSource: observations.evidenceSource,
      freshnessStatus: observations.freshnessStatus,
      value: observations.valueJson,
      placeId: places.id,
      placeName: places.name,
      featureKey: featureDefinitions.featureKey,
      featureName: featureDefinitions.displayName,
      contributorId: observations.installationId,
      observedAt: observations.observedAt,
      appealUntil: observations.appealUntil,
      createdAt: observations.createdAt,
      updatedAt: observations.updatedAt,
    }).from(observations)
      .innerJoin(places, eq(observations.placeId, places.id))
      .innerJoin(featureDefinitions, eq(observations.featureDefinitionId, featureDefinitions.id))
      .where(condition)
      .orderBy(desc(observations.updatedAt), desc(observations.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ value: count() }).from(observations).where(condition),
  ]);
  return { items, total: totals[0]?.value ?? 0, limit: input.limit, offset: input.offset };
}

export async function getObservationReviewDetail(observationId: string) {
  const [observation] = await db.select({
    id: observations.id,
    installationId: observations.installationId,
    moderationStatus: observations.moderationStatus,
    moderationReason: observations.moderationReason,
    moderationVersion: observations.moderationVersion,
    moderatedAt: observations.moderatedAt,
    appealUntil: observations.appealUntil,
    evidenceGrade: observations.evidenceGrade,
    evidenceSource: observations.evidenceSource,
    freshnessStatus: observations.freshnessStatus,
    confidence: observations.confidence,
    value: observations.valueJson,
    observedAt: observations.observedAt,
    expiresAt: observations.expiresAt,
    locationProofPassed: observations.locationProofPassed,
    locationDistanceBucket: observations.locationDistanceBucket,
    locationVerifiedAt: observations.locationVerifiedAt,
    placeId: places.id,
    placeName: places.name,
    placeAddress: places.address,
    unitId: placeUnits.id,
    unitName: placeUnits.name,
    facilityId: facilities.id,
    facilityName: facilities.name,
    featureKey: featureDefinitions.featureKey,
    featureName: featureDefinitions.displayName,
    featureValueType: featureDefinitions.valueType,
    featureUnit: featureDefinitions.unit,
    contributorStatus: installationAccounts.status,
    contributorAcceptedCount: installationAccounts.acceptedContributionCount,
    contributorCreatedAt: installationAccounts.createdAt,
    createdAt: observations.createdAt,
    updatedAt: observations.updatedAt,
  }).from(observations)
    .innerJoin(places, eq(observations.placeId, places.id))
    .innerJoin(featureDefinitions, eq(observations.featureDefinitionId, featureDefinitions.id))
    .leftJoin(placeUnits, eq(observations.placeUnitId, placeUnits.id))
    .leftJoin(facilities, eq(observations.facilityId, facilities.id))
    .leftJoin(installationAccounts, eq(observations.installationId, installationAccounts.id))
    .where(and(eq(observations.id, observationId), eq(observations.evidenceSource, 'community')))
    .limit(1);
  if (!observation) return null;

  const [media, feedback, history] = await Promise.all([
    db.select({
      id: evidenceMedia.id,
      mimeType: evidenceMedia.mimeType,
      byteSize: evidenceMedia.byteSize,
      width: evidenceMedia.width,
      height: evidenceMedia.height,
      status: evidenceMedia.status,
      redactionConfirmed: evidenceMedia.redactionConfirmed,
      expiresAt: evidenceMedia.expiresAt,
      deletedAt: evidenceMedia.deletedAt,
      createdAt: evidenceMedia.createdAt,
    }).from(observationMedia)
      .innerJoin(evidenceMedia, eq(observationMedia.mediaId, evidenceMedia.id))
      .where(eq(observationMedia.observationId, observationId)),
    db.select().from(userFeedback)
      .where(and(eq(userFeedback.targetType, 'observation'), eq(userFeedback.targetId, observationId)))
      .orderBy(desc(userFeedback.createdAt)),
    db.select({
      id: auditEvents.id,
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      action: auditEvents.action,
      reason: auditEvents.reason,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    }).from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'observation'), eq(auditEvents.targetId, observationId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(100),
  ]);
  return { observation, media, feedback, history };
}

export async function decideObservationReview(input: {
  actorId: string;
  observationId: string;
  expectedVersion: number;
  decision: ObservationModerationDecision;
  reason: string;
  requestId: string;
  now?: Date;
}): Promise<ReviewResult<{ id: string; moderationStatus: string; evidenceGrade: string; moderationVersion: number; appealUntil: Date | null }>> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(observations)
      .where(and(eq(observations.id, input.observationId), eq(observations.evidenceSource, 'community')))
      .for('update')
      .limit(1);
    if (!current) return failure('OBSERVATION_NOT_FOUND', '证据观测不存在');
    if (current.moderationVersion !== input.expectedVersion) {
      return failure('OBSERVATION_REVIEW_CONFLICT', '证据已被其他管理员更新，请刷新后重试');
    }
    if (input.decision === 'request_changes' && !current.installationId) {
      return failure('OBSERVATION_REVIEW_FORBIDDEN', '提交账户已删除，无法要求用户补充资料');
    }
    const [activeAppeal] = await tx.select({ id: userFeedback.id }).from(userFeedback).where(and(
      eq(userFeedback.feedbackType, 'appeal'),
      eq(userFeedback.targetType, 'observation'),
      eq(userFeedback.targetId, current.id),
      or(eq(userFeedback.status, 'open'), eq(userFeedback.status, 'in_review')),
    )).limit(1);
    if (activeAppeal) return failure('OBSERVATION_REVIEW_FORBIDDEN', '该证据存在待处理申诉，请从申诉队列处理');
    const currentStatus = observationStatus(current.moderationStatus);
    const currentGrade = evidenceGrade(current.evidenceGrade);
    if (!currentStatus || !currentGrade) return failure('OBSERVATION_REVIEW_CONFLICT', '证据状态不受当前版本支持');
    const plan = planObservationModeration({ currentStatus, currentGrade, decision: input.decision, now });
    if (!plan) return failure('OBSERVATION_REVIEW_FORBIDDEN', '已撤回证据不可重新审核');
    const responseDeadline = input.decision === 'request_changes'
      ? new Date(now.getTime() + FEEDBACK_RESPONSE_WINDOW_MS)
      : null;

    const [updated] = await tx.update(observations).set({
      moderationStatus: plan.moderationStatus,
      moderationReason: input.reason,
      moderationVersion: sql`${observations.moderationVersion} + 1`,
      moderatedAt: now,
      appealUntil: plan.appealUntil,
      evidenceGrade: plan.evidenceGrade,
      updatedAt: now,
    }).where(eq(observations.id, current.id)).returning({
      id: observations.id,
      moderationStatus: observations.moderationStatus,
      evidenceGrade: observations.evidenceGrade,
      moderationVersion: observations.moderationVersion,
      appealUntil: observations.appealUntil,
    });
    if (!updated) throw new Error('OBSERVATION_REVIEW_UPDATE_FAILED');

    const mediaLinks = await tx.select({ mediaId: observationMedia.mediaId })
      .from(observationMedia)
      .where(eq(observationMedia.observationId, current.id));
    if (mediaLinks.length > 0) {
      await tx.update(evidenceMedia).set({
        status: plan.mediaStatus,
        expiresAt: responseDeadline ?? plan.mediaExpiresAt,
        updatedAt: now,
      }).where(and(inArray(evidenceMedia.id, mediaLinks.map((item) => item.mediaId)), isNull(evidenceMedia.deletedAt)));
    }
    if (current.installationId && plan.acceptedContributionDelta !== 0) {
      await tx.update(installationAccounts).set({
        acceptedContributionCount: sql`greatest(${installationAccounts.acceptedContributionCount} + ${plan.acceptedContributionDelta}, 0)`,
        updatedAt: now,
      }).where(eq(installationAccounts.id, current.installationId));
    }
    if (input.decision === 'request_changes' && current.installationId) {
      const [existingRequest] = await tx.select({ id: userFeedback.id }).from(userFeedback).where(and(
        eq(userFeedback.installationId, current.installationId),
        eq(userFeedback.feedbackType, 'supplement_request'),
        eq(userFeedback.targetType, 'observation'),
        eq(userFeedback.targetId, current.id),
        or(eq(userFeedback.status, 'open'), eq(userFeedback.status, 'in_review')),
      )).limit(1);
      if (existingRequest) {
        await tx.update(userFeedback).set({
          message: input.reason,
          status: 'open',
          createdByAdminId: input.actorId,
          expiresAt: responseDeadline,
          updatedAt: now,
        }).where(eq(userFeedback.id, existingRequest.id));
      } else {
        await tx.insert(userFeedback).values({
          installationId: current.installationId,
          feedbackType: 'supplement_request',
          sourceType: 'admin',
          targetType: 'observation',
          targetId: current.id,
          message: input.reason,
          createdByAdminId: input.actorId,
          expiresAt: responseDeadline,
        });
      }
    } else {
      await tx.update(userFeedback).set({
        status: 'resolved',
        resolutionReason: input.reason,
        resolvedByAdminId: input.actorId,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(
        eq(userFeedback.feedbackType, 'supplement_request'),
        eq(userFeedback.targetType, 'observation'),
        eq(userFeedback.targetId, current.id),
        or(eq(userFeedback.status, 'open'), eq(userFeedback.status, 'in_review')),
      ));
    }
    await tx.insert(auditEvents).values({
      actorType: 'admin',
      actorId: input.actorId,
      action: `observation.moderation_${input.decision}`,
      targetType: 'observation',
      targetId: current.id,
      reason: input.reason,
      metadata: {
        before: { status: current.moderationStatus, grade: current.evidenceGrade, version: current.moderationVersion },
        after: { status: plan.moderationStatus, grade: plan.evidenceGrade, version: updated.moderationVersion },
        media_retained_until: (responseDeadline ?? plan.mediaExpiresAt)?.toISOString() ?? null,
      },
      requestId: input.requestId,
    });
    return { ok: true, value: updated };
  });
}

export async function listAppeals(input: { status?: 'open' | 'in_review' | 'resolved' | 'rejected'; limit: number; offset: number }) {
  const condition = and(
    eq(userFeedback.feedbackType, 'appeal'),
    eq(userFeedback.targetType, 'observation'),
    eq(observations.evidenceSource, 'community'),
    input.status ? eq(userFeedback.status, input.status) : or(eq(userFeedback.status, 'open'), eq(userFeedback.status, 'in_review')),
  );
  const [items, totals] = await Promise.all([
    db.select({
      id: userFeedback.id,
      status: userFeedback.status,
      message: userFeedback.message,
      resolutionReason: userFeedback.resolutionReason,
      observationId: observations.id,
      observationStatus: observations.moderationStatus,
      moderationVersion: observations.moderationVersion,
      placeName: places.name,
      featureName: featureDefinitions.displayName,
      createdAt: userFeedback.createdAt,
      updatedAt: userFeedback.updatedAt,
      expiresAt: userFeedback.expiresAt,
    }).from(userFeedback)
      .innerJoin(observations, and(eq(userFeedback.targetType, 'observation'), eq(userFeedback.targetId, observations.id)))
      .innerJoin(places, eq(observations.placeId, places.id))
      .innerJoin(featureDefinitions, eq(observations.featureDefinitionId, featureDefinitions.id))
      .where(condition)
      .orderBy(desc(userFeedback.updatedAt), desc(userFeedback.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ value: count() }).from(userFeedback)
      .innerJoin(observations, and(eq(userFeedback.targetType, 'observation'), eq(userFeedback.targetId, observations.id)))
      .where(condition),
  ]);
  return { items, total: totals[0]?.value ?? 0, limit: input.limit, offset: input.offset };
}

export async function resolveAppeal(input: {
  actorId: string;
  appealId: string;
  expectedObservationVersion: number;
  expectedAppealUpdatedAt: Date;
  decision: 'reopen' | 'reject' | 'request_more';
  reason: string;
  requestId: string;
  now?: Date;
}): Promise<ReviewResult<{ id: string; status: string; observationStatus: string; observationVersion: number }>> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [appealReference] = await tx.select({ targetId: userFeedback.targetId }).from(userFeedback).where(and(
      eq(userFeedback.id, input.appealId),
      eq(userFeedback.feedbackType, 'appeal'),
      eq(userFeedback.targetType, 'observation'),
    )).limit(1);
    if (!appealReference) return failure('APPEAL_NOT_FOUND', '申诉不存在');
    const [observation] = await tx.select().from(observations)
      .where(and(
        eq(observations.id, appealReference.targetId),
        eq(observations.moderationStatus, 'rejected'),
        eq(observations.evidenceSource, 'community'),
      ))
      .for('update')
      .limit(1);
    const [appeal] = await tx.select().from(userFeedback).where(and(
      eq(userFeedback.id, input.appealId),
      eq(userFeedback.feedbackType, 'appeal'),
      eq(userFeedback.targetType, 'observation'),
      eq(userFeedback.targetId, appealReference.targetId),
    )).for('update').limit(1);
    if (!appeal) return failure('APPEAL_NOT_FOUND', '申诉不存在');
    if (appeal.status !== 'open' && appeal.status !== 'in_review') {
      return failure('APPEAL_REVIEW_CONFLICT', '申诉已结案，请刷新后重试');
    }
    if (!appeal.expiresAt || appeal.expiresAt <= now) {
      return failure('APPEAL_REVIEW_CONFLICT', '申诉处理期限已结束，请刷新后重试');
    }
    if (appeal.updatedAt.getTime() !== input.expectedAppealUpdatedAt.getTime()) {
      return failure('APPEAL_REVIEW_CONFLICT', '申诉已被其他管理员更新，请刷新后重试');
    }
    if (!observation || observation.moderationVersion !== input.expectedObservationVersion) {
      return failure('APPEAL_REVIEW_CONFLICT', '关联证据已更新，请刷新后重试');
    }

    let feedbackStatus = appeal.status;
    let observationStatus = observation.moderationStatus;
    let observationVersion = observation.moderationVersion;
    if (input.decision === 'request_more') {
      feedbackStatus = 'in_review';
      if (!observation.appealUntil) return failure('APPEAL_REVIEW_CONFLICT', '关联证据缺少申诉截止时间');
      const requestedDeadline = new Date(now.getTime() + FEEDBACK_RESPONSE_WINDOW_MS);
      const hardDeadline = new Date(observation.appealUntil.getTime() + FEEDBACK_RESPONSE_WINDOW_MS);
      const responseDeadline = requestedDeadline < hardDeadline ? requestedDeadline : hardDeadline;
      if (responseDeadline <= now) return failure('APPEAL_REVIEW_CONFLICT', '申诉补充资料期限已结束');
      await tx.update(userFeedback).set({
        status: feedbackStatus,
        resolutionReason: input.reason,
        expiresAt: responseDeadline,
        updatedAt: now,
      }).where(eq(userFeedback.id, appeal.id));
      const mediaLinks = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia)
        .where(eq(observationMedia.observationId, observation.id));
      if (mediaLinks.length > 0) {
        await tx.update(evidenceMedia).set({ status: 'appeal_hold', expiresAt: responseDeadline, updatedAt: now })
          .where(and(inArray(evidenceMedia.id, mediaLinks.map((item) => item.mediaId)), isNull(evidenceMedia.deletedAt)));
      }
    } else {
      feedbackStatus = input.decision === 'reopen' ? 'resolved' : 'rejected';
      await tx.update(userFeedback).set({
        status: feedbackStatus,
        resolutionReason: input.reason,
        resolvedByAdminId: input.actorId,
        resolvedAt: now,
        updatedAt: now,
      }).where(eq(userFeedback.id, appeal.id));
      if (input.decision === 'reopen') {
        const [updatedObservation] = await tx.update(observations).set({
          moderationStatus: 'pending',
          moderationReason: input.reason,
          moderationVersion: sql`${observations.moderationVersion} + 1`,
          moderatedAt: now,
          appealUntil: null,
          evidenceGrade: 'U',
          updatedAt: now,
        }).where(eq(observations.id, observation.id)).returning({
          moderationStatus: observations.moderationStatus,
          moderationVersion: observations.moderationVersion,
        });
        if (!updatedObservation) throw new Error('APPEAL_REOPEN_FAILED');
        observationStatus = updatedObservation.moderationStatus;
        observationVersion = updatedObservation.moderationVersion;
        const mediaLinks = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia)
          .where(eq(observationMedia.observationId, observation.id));
        if (mediaLinks.length > 0) {
          await tx.update(evidenceMedia).set({ status: 'linked', expiresAt: null, updatedAt: now })
            .where(and(inArray(evidenceMedia.id, mediaLinks.map((item) => item.mediaId)), isNull(evidenceMedia.deletedAt)));
        }
      } else {
        const mediaLinks = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia)
          .where(eq(observationMedia.observationId, observation.id));
        if (mediaLinks.length > 0) {
          await tx.update(evidenceMedia).set({ status: 'rejected', expiresAt: now, updatedAt: now })
            .where(and(inArray(evidenceMedia.id, mediaLinks.map((item) => item.mediaId)), isNull(evidenceMedia.deletedAt)));
        }
      }
    }
    await tx.insert(auditEvents).values({
      actorType: 'admin',
      actorId: input.actorId,
      action: `appeal.${input.decision}`,
      targetType: 'observation',
      targetId: observation.id,
      reason: input.reason,
      metadata: { appeal_id: appeal.id, feedback_status: feedbackStatus, observation_status: observationStatus },
      requestId: input.requestId,
    });
    return { ok: true, value: { id: appeal.id, status: feedbackStatus, observationStatus, observationVersion } };
  });
}

export async function listVerificationReviews(input: { status?: 'unreviewed' | 'confirmed' | 'flagged'; limit: number; offset: number }) {
  const condition = eq(verificationRecords.adminReviewStatus, input.status ?? 'unreviewed');
  const [items, totals] = await Promise.all([
    db.select({
      id: verificationRecords.id,
      placeId: verificationRecords.placeId,
      placeUnitId: verificationRecords.placeUnitId,
      scene: verificationRecords.scene,
      status: verificationRecords.status,
      result: verificationRecords.resultJson,
      confidence: verificationRecords.confidence,
      riskLevel: verificationRecords.riskLevel,
      modelName: verificationRecords.modelName,
      promptVersion: verificationRecords.promptVersion,
      originalMediaStored: verificationRecords.originalMediaStored,
      temporaryMediaDeletedAt: verificationRecords.temporaryMediaDeletedAt,
      failureCode: verificationRecords.failureCode,
      adminReviewStatus: verificationRecords.adminReviewStatus,
      adminReviewReason: verificationRecords.adminReviewReason,
      adminReviewedAt: verificationRecords.adminReviewedAt,
      createdAt: verificationRecords.createdAt,
      updatedAt: verificationRecords.updatedAt,
    }).from(verificationRecords).where(condition)
      .orderBy(desc(verificationRecords.createdAt), desc(verificationRecords.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ value: count() }).from(verificationRecords).where(condition),
  ]);
  return { items, total: totals[0]?.value ?? 0, limit: input.limit, offset: input.offset };
}

export async function reviewVerification(input: {
  actorId: string;
  verificationId: string;
  expectedUpdatedAt: Date;
  decision: 'confirm' | 'flag';
  reason: string;
  requestId: string;
  now?: Date;
}): Promise<ReviewResult<{ id: string; adminReviewStatus: string; updatedAt: Date }>> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(verificationRecords)
      .where(eq(verificationRecords.id, input.verificationId))
      .for('update')
      .limit(1);
    if (!current) return failure('VERIFICATION_NOT_FOUND', 'AI 验真记录不存在');
    if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      return failure('VERIFICATION_REVIEW_CONFLICT', 'AI 验真记录已更新，请刷新后重试');
    }
    const adminReviewStatus = input.decision === 'confirm' ? 'confirmed' : 'flagged';
    const [updated] = await tx.update(verificationRecords).set({
      adminReviewStatus,
      adminReviewReason: input.reason,
      adminReviewedAt: now,
      updatedAt: now,
    }).where(eq(verificationRecords.id, current.id)).returning({
      id: verificationRecords.id,
      adminReviewStatus: verificationRecords.adminReviewStatus,
      updatedAt: verificationRecords.updatedAt,
    });
    if (!updated) throw new Error('VERIFICATION_REVIEW_UPDATE_FAILED');
    await tx.insert(auditEvents).values({
      actorType: 'admin',
      actorId: input.actorId,
      action: `verification.${input.decision}`,
      targetType: 'verification_record',
      targetId: current.id,
      reason: input.reason,
      metadata: { before: current.adminReviewStatus, after: adminReviewStatus },
      requestId: input.requestId,
    });
    return { ok: true, value: updated };
  });
}

export async function getObservationReviewMedia(mediaId: string) {
  const [media] = await db.select({
    id: evidenceMedia.id,
    storagePath: evidenceMedia.storagePath,
    mimeType: evidenceMedia.mimeType,
    byteSize: evidenceMedia.byteSize,
    observationId: observationMedia.observationId,
  }).from(evidenceMedia)
    .innerJoin(observationMedia, eq(evidenceMedia.id, observationMedia.mediaId))
    .innerJoin(observations, eq(observationMedia.observationId, observations.id))
    .where(and(
      eq(evidenceMedia.id, mediaId),
      eq(observations.evidenceSource, 'community'),
      eq(evidenceMedia.redactionConfirmed, true),
      isNull(evidenceMedia.deletedAt),
    ))
    .limit(1);
  return media ?? null;
}

export async function auditObservationMediaAccess(input: {
  actorId: string;
  mediaId: string;
  observationId: string;
  requestId: string;
}): Promise<void> {
  await db.insert(auditEvents).values({
    actorType: 'admin',
    actorId: input.actorId,
    action: 'evidence_media.viewed',
    targetType: 'observation',
    targetId: input.observationId,
    metadata: { media_id: input.mediaId },
    requestId: input.requestId,
  });
}

function observationStatus(value: string): ObservationModerationStatus | null {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'withdrawn' ? value : null;
}

function evidenceGrade(value: string): EvidenceGrade | null {
  return value === 'A' || value === 'B' || value === 'C' || value === 'U' ? value : null;
}

function failure(code: ReviewFailureCode, message: string): ReviewResult<never> {
  return { ok: false, code, message };
}
