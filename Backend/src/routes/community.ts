import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { calculateVoteWeight, sanitizeStoredConsensusSnapshot, toPublicConsensusSnapshot, type ReviewVoteInput } from '../domain/consensus.js';
import { canSubmitObservationAppeal, FEEDBACK_RESPONSE_WINDOW_MS } from '../domain/moderation.js';
import {
  auditEvents,
  communityReviewTasks,
  communityReviewVotes,
  db,
  evidenceMedia,
  facilities,
  featureDefinitions,
  installationAccounts,
  locationProofs,
  observationMedia,
  observations,
  places,
  placeUnits,
  userFeedback,
} from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { isFeatureValueCompatible } from '../domain/feature-values.js';
import { evaluateLocationProof } from '../domain/location-proof.js';
import { lockCanonicalPlace, resolveActivePlace } from '../services/place-resolution.js';
import {
  CommunityReviewProtectionUnavailableError,
  consumeCommunityReviewPermit,
  consumeLocationProofPermit,
  fingerprintCommunityReviewSource,
} from '../services/community-review-guard.js';
import { recomputeCommunityConsensus } from '../services/community-consensus.js';
import type { AppBindings } from '../types.js';

const observationSchema = z.object({
  place_id: z.uuid(),
  place_unit_id: z.uuid().optional(),
  facility_id: z.uuid().optional(),
  feature_key: z.string().min(1).max(128),
  value: z.union([z.boolean(), z.number(), z.string(), z.record(z.string(), z.unknown())]),
  observed_at: z.iso.datetime().optional(),
  media_ids: z.array(z.uuid()).max(6).refine((ids) => new Set(ids).size === ids.length).default([]),
  location_proof_id: z.uuid().optional(),
});

const proofSchema = z.object({
  place_id: z.uuid(),
  review_task_id: z.uuid().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy_meters: z.number().positive().max(500),
});

const reviewTaskListSchema = z.object({ cursor: z.string().max(512).optional() });
const mySubmissionQuerySchema = z.object({ submission_id: z.uuid() });

const voteSchema = z.object({
  submission_id: z.uuid(),
  answer: z.enum(['present', 'absent', 'unknown']),
  media_id: z.uuid().optional(),
  location_proof_id: z.uuid().optional(),
});

const COMMUNITY_REVIEW_MEDIA_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

const appealSchema = z.object({
  message: z.string().trim().min(6).max(2000),
});

const supplementSchema = z.object({
  feedback_id: z.uuid(),
  expected_observation_version: z.number().int().min(0),
  expected_feedback_updated_at: z.iso.datetime(),
  message: z.string().trim().min(6).max(2000),
  value: z.union([z.boolean(), z.number(), z.string(), z.record(z.string(), z.unknown())]).optional(),
  media_ids: z.array(z.uuid()).max(6).refine((ids) => new Set(ids).size === ids.length).default([]),
});

export const observationsRouter = new Hono<AppBindings>();
export const reviewTasksRouter = new Hono<AppBindings>();
export const locationProofsRouter = new Hono<AppBindings>();

observationsRouter.use('*', requireUser);
reviewTasksRouter.use('*', requireUser);
locationProofsRouter.use('*', requireUser);

observationsRouter.post('/', async (c) => {
  const parsed = observationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'OBSERVATION_INVALID', '现场观测参数无效');
  const input = parsed.data;
  if (input.place_unit_id && input.facility_id) return fail(c, 422, 'OBSERVATION_TARGET_INVALID', '地点单元和设施不能同时指定');
  const place = await resolveActivePlace(input.place_id);
  if (!place) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在');
  if (input.place_unit_id) {
    const [unit] = await db.select({ id: placeUnits.id }).from(placeUnits).where(and(eq(placeUnits.id, input.place_unit_id), eq(placeUnits.placeId, place.id))).limit(1);
    if (!unit) return fail(c, 422, 'OBSERVATION_TARGET_INVALID', '地点单元不属于所选地点');
  }
  if (input.facility_id) {
    const [facility] = await db.select({ id: facilities.id }).from(facilities).where(and(eq(facilities.id, input.facility_id), eq(facilities.placeId, place.id))).limit(1);
    if (!facility) return fail(c, 422, 'OBSERVATION_TARGET_INVALID', '设施不属于所选地点');
  }
  const [feature] = await db.select().from(featureDefinitions).where(and(eq(featureDefinitions.featureKey, input.feature_key), eq(featureDefinitions.active, true))).limit(1);
  if (!feature) return fail(c, 422, 'FEATURE_NOT_SUPPORTED', '该无障碍字段尚未配置');
  const targetType = input.facility_id ? 'facility' : input.place_unit_id ? 'place_unit' : 'place';
  if (!feature.targetTypes.includes(targetType)) return fail(c, 422, 'FEATURE_TARGET_INVALID', '该无障碍字段不适用于当前观测对象');
  if (!isFeatureValueCompatible(feature.valueType, input.value)) return fail(c, 422, 'FEATURE_VALUE_INVALID', '现场观测值与字段类型不匹配');
  const proof = input.location_proof_id ? (await db.select().from(locationProofs).where(and(
    eq(locationProofs.id, input.location_proof_id),
    eq(locationProofs.installationId, c.get('installationId')),
    eq(locationProofs.placeId, place.id),
    isNull(locationProofs.reviewTaskId),
    gt(locationProofs.expiresAt, new Date()),
    isNull(locationProofs.consumedAt),
  )).limit(1))[0] : undefined;
  if (input.location_proof_id && !proof) return fail(c, 422, 'LOCATION_PROOF_INVALID', '位置证明不存在、已过期或已使用');
  try {
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [account] = await tx.select({ status: installationAccounts.status })
        .from(installationAccounts)
        .where(eq(installationAccounts.id, c.get('installationId')))
        .for('update')
        .limit(1);
      if (account?.status !== 'active') throw new CommunityConflictError('ACCOUNT_NOT_ACTIVE');
      const lockedPlace = await lockCanonicalPlace(tx, place.id);
      if (!lockedPlace) throw new CommunityConflictError('PLACE_NOT_ACTIVE');
      const claimedProof = proof ? (await tx.update(locationProofs).set({ consumedAt: new Date() }).where(and(
        eq(locationProofs.id, proof.id),
        isNull(locationProofs.reviewTaskId),
        gt(locationProofs.expiresAt, new Date()),
        isNull(locationProofs.consumedAt),
      )).returning({
        passed: locationProofs.passed,
        distanceBucket: locationProofs.distanceBucket,
      }))[0] : undefined;
      if (proof && !claimedProof) throw new CommunityConflictError('LOCATION_PROOF_ALREADY_USED');
      const claimedMediaIds = input.media_ids.length === 0 ? [] : await tx.update(evidenceMedia).set({
        status: 'linked',
        linkedAt: now,
        expiresAt: null,
        updatedAt: now,
      }).where(and(
        inArray(evidenceMedia.id, input.media_ids),
        eq(evidenceMedia.installationId, c.get('installationId')),
        eq(evidenceMedia.status, 'pending_link'),
        isNull(evidenceMedia.deletedAt),
      )).returning({ id: evidenceMedia.id });
      if (claimedMediaIds.length !== input.media_ids.length) throw new CommunityConflictError('MEDIA_ALREADY_LINKED');
      const [observation] = await tx.insert(observations).values({
        installationId: c.get('installationId'),
        placeId: lockedPlace.id,
        placeUnitId: input.place_unit_id,
        facilityId: input.facility_id,
        featureDefinitionId: feature.id,
        valueJson: input.value,
        evidenceSource: 'community',
        moderationStatus: 'pending',
        evidenceGrade: 'U',
        locationProofPassed: claimedProof?.passed ?? false,
        locationDistanceBucket: claimedProof?.distanceBucket,
        locationVerifiedAt: claimedProof ? now : undefined,
        observedAt: input.observed_at ? new Date(input.observed_at) : now,
      }).returning();
      if (!observation) throw new Error('OBSERVATION_INSERT_FAILED');
      for (const media of claimedMediaIds) {
        await tx.insert(observationMedia).values({ observationId: observation.id, mediaId: media.id });
      }
      await tx.insert(auditEvents).values({ actorType: 'installation', actorId: c.get('installationId'), action: 'observation.submitted', targetType: 'observation', targetId: observation.id, requestId: c.get('requestId') });
      return observation;
    });
    return ok(c, result, '现场观测已提交，待审核或社区复核', 201);
  } catch (error) {
    if (error instanceof CommunityConflictError && error.code === 'LOCATION_PROOF_ALREADY_USED') {
      return fail(c, 409, error.code, '位置证明已被其他请求使用，请重新验证位置');
    }
    if (error instanceof CommunityConflictError && error.code === 'MEDIA_ALREADY_LINKED') {
      return fail(c, 409, error.code, '证据图片已被其他提交关联，请重新选择或上传');
    }
    if (error instanceof CommunityConflictError && error.code === 'ACCOUNT_NOT_ACTIVE') {
      return fail(c, 409, error.code, '匿名账户正在删除或已停用，无法继续提交');
    }
    if (error instanceof CommunityConflictError && error.code === 'PLACE_NOT_ACTIVE') {
      return fail(c, 409, error.code, '地点状态刚刚发生变化，请刷新地点后重新提交');
    }
    throw error;
  }
});

observationsRouter.post('/:id/withdraw', async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'OBSERVATION_ID_INVALID', '观测 ID 无效');
  const now = new Date();
  const withdrawn = await db.transaction(async (tx) => {
    const [account] = await tx.select({ status: installationAccounts.status })
      .from(installationAccounts)
      .where(eq(installationAccounts.id, c.get('installationId')))
      .for('update')
      .limit(1);
    if (account?.status !== 'active') return false;
    const activeReviewTasks = await tx.select({ id: communityReviewTasks.id }).from(communityReviewTasks).where(and(
      eq(communityReviewTasks.targetType, 'observation'),
      eq(communityReviewTasks.targetId, c.req.param('id')),
      or(eq(communityReviewTasks.status, 'pending_review'), eq(communityReviewTasks.status, 'conflicting')),
    )).orderBy(communityReviewTasks.id).for('update');
    const [observation] = await tx.select().from(observations).where(and(
    eq(observations.id, c.req.param('id')),
    eq(observations.installationId, c.get('installationId')),
    eq(observations.evidenceSource, 'community'),
    isNull(observations.withdrawnAt),
    )).for('update').limit(1);
    if (!observation) return false;
    if (activeReviewTasks.length > 0) {
      await tx.update(communityReviewTasks).set({
        status: 'cancelled',
        resolutionReason: '原社区观测已由提交者撤回',
        resolvedAt: now,
        updatedAt: now,
      }).where(inArray(communityReviewTasks.id, activeReviewTasks.map((task) => task.id)));
    }
    await tx.update(observations).set({
      withdrawnAt: now,
      moderationStatus: 'withdrawn',
      moderationVersion: sql`${observations.moderationVersion} + 1`,
      updatedAt: now,
    }).where(eq(observations.id, observation.id));
    if (observation.moderationStatus === 'approved') {
      await tx.update(installationAccounts).set({
        acceptedContributionCount: sql`greatest(${installationAccounts.acceptedContributionCount} - 1, 0)`,
        updatedAt: now,
      }).where(eq(installationAccounts.id, c.get('installationId')));
    }
    const links = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia).where(eq(observationMedia.observationId, observation.id));
    if (links.length > 0) await tx.update(evidenceMedia).set({ status: 'withdrawn', expiresAt: now, updatedAt: now }).where(inArray(evidenceMedia.id, links.map((link) => link.mediaId)));
    await tx.update(userFeedback).set({ status: 'withdrawn', resolvedAt: now, updatedAt: now }).where(and(
      eq(userFeedback.installationId, c.get('installationId')),
      eq(userFeedback.targetType, 'observation'),
      eq(userFeedback.targetId, observation.id),
      or(eq(userFeedback.status, 'open'), eq(userFeedback.status, 'in_review')),
    ));
    await tx.insert(auditEvents).values({ actorType: 'installation', actorId: c.get('installationId'), action: 'observation.withdrawn', targetType: 'observation', targetId: observation.id, requestId: c.get('requestId') });
    return true;
  });
  if (!withdrawn) return fail(c, 404, 'OBSERVATION_NOT_FOUND', '观测不存在或已撤回');
  return ok(c, { withdrawn: true });
});

observationsRouter.get('/:id/moderation', async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'OBSERVATION_ID_INVALID', '观测 ID 无效');
  const [observation] = await db.select({
    id: observations.id,
    moderationStatus: observations.moderationStatus,
    moderationReason: observations.moderationReason,
    moderationVersion: observations.moderationVersion,
    moderatedAt: observations.moderatedAt,
    appealUntil: observations.appealUntil,
    evidenceGrade: observations.evidenceGrade,
    withdrawnAt: observations.withdrawnAt,
    updatedAt: observations.updatedAt,
  }).from(observations).where(and(
    eq(observations.id, c.req.param('id')),
    eq(observations.installationId, c.get('installationId')),
    eq(observations.evidenceSource, 'community'),
  )).limit(1);
  if (!observation) return fail(c, 404, 'OBSERVATION_NOT_FOUND', '观测不存在');
  const feedback = await db.select({
    id: userFeedback.id,
    feedbackType: userFeedback.feedbackType,
    sourceType: userFeedback.sourceType,
    message: userFeedback.message,
    status: userFeedback.status,
    resolutionReason: userFeedback.resolutionReason,
    expiresAt: userFeedback.expiresAt,
    resolvedAt: userFeedback.resolvedAt,
    createdAt: userFeedback.createdAt,
    updatedAt: userFeedback.updatedAt,
  }).from(userFeedback).where(and(
    eq(userFeedback.installationId, c.get('installationId')),
    eq(userFeedback.targetType, 'observation'),
    eq(userFeedback.targetId, observation.id),
  )).orderBy(desc(userFeedback.createdAt));
  return ok(c, { observation, feedback });
});

observationsRouter.post('/:id/appeals', async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'OBSERVATION_ID_INVALID', '观测 ID 无效');
  const parsed = appealSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'APPEAL_INVALID', '申诉说明应为 6 到 2000 个字符');
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const [account] = await tx.select({ status: installationAccounts.status })
        .from(installationAccounts)
        .where(eq(installationAccounts.id, c.get('installationId')))
        .for('update')
        .limit(1);
      if (account?.status !== 'active') return { kind: 'account_inactive' } as const;
      const [observation] = await tx.select().from(observations).where(and(
        eq(observations.id, c.req.param('id')),
        eq(observations.installationId, c.get('installationId')),
        eq(observations.evidenceSource, 'community'),
      )).for('update').limit(1);
      if (!observation) return { kind: 'not_found' } as const;
      if (!canSubmitObservationAppeal({
        status: observation.moderationStatus,
        appealUntil: observation.appealUntil,
        now,
      })) return { kind: 'forbidden' } as const;
      const [existingCycleAppeal] = await tx.select({ id: userFeedback.id }).from(userFeedback).where(and(
        eq(userFeedback.installationId, c.get('installationId')),
        eq(userFeedback.feedbackType, 'appeal'),
        eq(userFeedback.targetType, 'observation'),
        eq(userFeedback.targetId, observation.id),
        observation.moderatedAt ? gte(userFeedback.createdAt, observation.moderatedAt) : undefined,
      )).limit(1);
      if (existingCycleAppeal) return { kind: 'duplicate' } as const;
      const responseDeadline = new Date(now.getTime() + FEEDBACK_RESPONSE_WINDOW_MS);
      const holdUntil = observation.appealUntil && observation.appealUntil > responseDeadline
        ? observation.appealUntil
        : responseDeadline;
      const [appeal] = await tx.insert(userFeedback).values({
        installationId: c.get('installationId'),
        feedbackType: 'appeal',
        sourceType: 'installation',
        targetType: 'observation',
        targetId: observation.id,
        message: parsed.data.message,
        expiresAt: holdUntil,
      }).returning({ id: userFeedback.id, status: userFeedback.status, createdAt: userFeedback.createdAt });
      if (!appeal) throw new Error('APPEAL_INSERT_FAILED');
      const mediaLinks = await tx.select({
        mediaId: observationMedia.mediaId,
        status: evidenceMedia.status,
        deletedAt: evidenceMedia.deletedAt,
      }).from(observationMedia)
        .innerJoin(evidenceMedia, eq(observationMedia.mediaId, evidenceMedia.id))
        .where(eq(observationMedia.observationId, observation.id));
      const availableMediaIds = mediaLinks
        .filter((item) => item.status === 'rejected' && item.deletedAt === null)
        .map((item) => item.mediaId);
      if (availableMediaIds.length > 0) {
        const heldMedia = await tx.update(evidenceMedia).set({ status: 'appeal_hold', expiresAt: holdUntil, updatedAt: now }).where(and(
          inArray(evidenceMedia.id, availableMediaIds),
          eq(evidenceMedia.status, 'rejected'),
          isNull(evidenceMedia.deletedAt),
        )).returning({ id: evidenceMedia.id });
        if (heldMedia.length !== availableMediaIds.length) throw new CommunityConflictError('APPEAL_MEDIA_UNAVAILABLE');
      }
      await tx.insert(auditEvents).values({
        actorType: 'installation',
        actorId: c.get('installationId'),
        action: 'observation.appealed',
        targetType: 'observation',
        targetId: observation.id,
        metadata: {
          appeal_id: appeal.id,
          held_media_count: availableMediaIds.length,
          unavailable_media_count: mediaLinks.length - availableMediaIds.length,
        },
        requestId: c.get('requestId'),
      });
      return { kind: 'created', appeal } as const;
    });
    if (result.kind === 'not_found') return fail(c, 404, 'OBSERVATION_NOT_FOUND', '观测不存在');
    if (result.kind === 'account_inactive') return fail(c, 409, 'ACCOUNT_NOT_ACTIVE', '匿名账户正在删除或已停用，无法提交申诉');
    if (result.kind === 'forbidden') return fail(c, 409, 'APPEAL_NOT_ALLOWED', '仅可在驳回后的申诉期内提交一次有效申诉');
    if (result.kind === 'duplicate') return fail(c, 409, 'APPEAL_ALREADY_EXISTS', '本次驳回已经提交过申诉');
    return ok(c, result.appeal, '申诉已提交', 201);
  } catch (error) {
    if (isUniqueViolation(error)) return fail(c, 409, 'APPEAL_ALREADY_EXISTS', '该观测已有待处理申诉');
    if (error instanceof CommunityConflictError && error.code === 'APPEAL_MEDIA_UNAVAILABLE') {
      return fail(c, 409, error.code, '申诉证据图片已过期或正在清理，请联系管理员复核审计记录');
    }
    throw error;
  }
});

observationsRouter.post('/:id/supplements', async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'OBSERVATION_ID_INVALID', '观测 ID 无效');
  const parsed = supplementSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'SUPPLEMENT_INVALID', '补充资料参数无效');
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [account] = await tx.select({ status: installationAccounts.status })
      .from(installationAccounts)
      .where(eq(installationAccounts.id, c.get('installationId')))
      .for('update')
      .limit(1);
    if (account?.status !== 'active') return { kind: 'account_inactive' } as const;
    const [observation] = await tx.select().from(observations).where(and(
      eq(observations.id, c.req.param('id')),
      eq(observations.installationId, c.get('installationId')),
      eq(observations.evidenceSource, 'community'),
      isNull(observations.withdrawnAt),
    )).for('update').limit(1);
    if (!observation) return { kind: 'not_found' } as const;
    const [feedback] = await tx.select().from(userFeedback).where(and(
      eq(userFeedback.id, parsed.data.feedback_id),
      eq(userFeedback.installationId, c.get('installationId')),
      eq(userFeedback.targetType, 'observation'),
      eq(userFeedback.targetId, observation.id),
      or(
        and(eq(userFeedback.feedbackType, 'supplement_request'), eq(userFeedback.status, 'open')),
        and(eq(userFeedback.feedbackType, 'appeal'), eq(userFeedback.status, 'in_review')),
      ),
      gt(userFeedback.expiresAt, now),
    )).for('update').limit(1);
    if (!feedback) return { kind: 'feedback_conflict' } as const;
    if (
      observation.moderationVersion !== parsed.data.expected_observation_version
      || feedback.updatedAt.getTime() !== new Date(parsed.data.expected_feedback_updated_at).getTime()
    ) return { kind: 'feedback_conflict' } as const;
    if (parsed.data.value !== undefined) {
      const [feature] = await tx.select({ valueType: featureDefinitions.valueType }).from(featureDefinitions)
        .where(eq(featureDefinitions.id, observation.featureDefinitionId)).limit(1);
      if (!feature || !isFeatureValueCompatible(feature.valueType, parsed.data.value)) return { kind: 'value_invalid' } as const;
    }
    const claimedMediaIds = parsed.data.media_ids.length === 0 ? [] : await tx.update(evidenceMedia).set({
        status: 'linked',
        linkedAt: now,
        expiresAt: null,
        updatedAt: now,
      }).where(and(
        inArray(evidenceMedia.id, parsed.data.media_ids),
        eq(evidenceMedia.installationId, c.get('installationId')),
        eq(evidenceMedia.status, 'pending_link'),
        isNull(evidenceMedia.deletedAt),
      )).returning({ id: evidenceMedia.id });
    if (claimedMediaIds.length !== parsed.data.media_ids.length) throw new CommunityConflictError('MEDIA_ALREADY_LINKED');
    const [updated] = await tx.update(observations).set({
      ...(parsed.data.value !== undefined ? { valueJson: parsed.data.value } : {}),
      moderationStatus: 'pending',
      moderationReason: null,
      moderationVersion: sql`${observations.moderationVersion} + 1`,
      moderatedAt: null,
      appealUntil: null,
      evidenceGrade: 'U',
      updatedAt: now,
    }).where(eq(observations.id, observation.id)).returning({
      id: observations.id,
      moderationStatus: observations.moderationStatus,
      moderationVersion: observations.moderationVersion,
    });
    if (!updated) throw new Error('OBSERVATION_SUPPLEMENT_UPDATE_FAILED');
    for (const media of claimedMediaIds) {
      await tx.insert(observationMedia).values({ observationId: observation.id, mediaId: media.id });
    }
    const allMediaLinks = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia)
      .where(eq(observationMedia.observationId, observation.id));
    if (allMediaLinks.length > 0) {
      await tx.update(evidenceMedia).set({ status: 'linked', expiresAt: null, updatedAt: now }).where(and(
        inArray(evidenceMedia.id, allMediaLinks.map((item) => item.mediaId)),
        isNull(evidenceMedia.deletedAt),
      ));
    }
    await tx.update(userFeedback).set({
      status: 'resolved',
      resolutionReason: parsed.data.message,
      resolvedAt: now,
      updatedAt: now,
    }).where(eq(userFeedback.id, feedback.id));
    await tx.insert(auditEvents).values({
      actorType: 'installation',
      actorId: c.get('installationId'),
      action: 'observation.supplement_submitted',
      targetType: 'observation',
      targetId: observation.id,
      metadata: { feedback_id: feedback.id, media_count: claimedMediaIds.length, value_updated: parsed.data.value !== undefined },
      requestId: c.get('requestId'),
    });
    return { kind: 'updated', observation: updated } as const;
  }).catch((error: unknown) => {
    if (error instanceof CommunityConflictError) return { kind: 'media_conflict' } as const;
    throw error;
  });
  if (result.kind === 'not_found') return fail(c, 404, 'OBSERVATION_NOT_FOUND', '观测不存在');
  if (result.kind === 'account_inactive') return fail(c, 409, 'ACCOUNT_NOT_ACTIVE', '匿名账户正在删除或已停用，无法补充资料');
  if (result.kind === 'feedback_conflict') return fail(c, 409, 'SUPPLEMENT_REQUEST_NOT_ACTIVE', '补充请求不存在或已处理');
  if (result.kind === 'value_invalid') return fail(c, 422, 'FEATURE_VALUE_INVALID', '补充观测值与字段类型不匹配');
  if (result.kind === 'media_conflict') return fail(c, 409, 'MEDIA_ALREADY_LINKED', '补充图片已被其他提交关联，请重新选择或上传');
  return ok(c, result.observation, '补充资料已提交，观测重新进入审核队列');
});

locationProofsRouter.post('/verify', async (c) => {
  const parsed = proofSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'LOCATION_PROOF_INVALID', '位置证明参数无效');
  const env = getEnv();
  const realIp = c.req.header('x-real-ip');
  const forwardedFor = c.req.header('x-forwarded-for');
  const sourceFingerprint = fingerprintCommunityReviewSource({
    trustProxy: env.TRUST_PROXY,
    ...(realIp ? { realIp } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
  }, env.AUTH_TOKEN_SECRET);
  let permit;
  try {
    permit = await consumeLocationProofPermit(c.get('installationId'), sourceFingerprint);
  } catch (error) {
    if (error instanceof CommunityReviewProtectionUnavailableError) {
      return fail(c, 503, 'LOCATION_PROOF_PROTECTION_UNAVAILABLE', '位置校验保护暂不可用，请稍后重试', { retryable: true });
    }
    throw error;
  }
  if (!permit.allowed) {
    c.header('Retry-After', String(permit.retryAfterSeconds));
    return fail(c, 429, 'LOCATION_PROOF_RATE_LIMITED', '位置校验过于频繁，请稍后再试', { retryable: true });
  }
  const candidate = await resolveActivePlace(parsed.data.place_id);
  if (!candidate) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在或已停用');
  const result = await db.transaction(async (tx) => {
    const [account] = await tx.select({ id: installationAccounts.id }).from(installationAccounts).where(and(
      eq(installationAccounts.id, c.get('installationId')),
      eq(installationAccounts.status, 'active'),
    )).for('update').limit(1);
    if (!account) return { kind: 'account_inactive' } as const;
    const place = await lockCanonicalPlace(tx, candidate.id);
    if (!place) return { kind: 'place_changed' } as const;
    const reviewTask = parsed.data.review_task_id ? (await tx.select({
      id: communityReviewTasks.id,
      locationRadiusMeters: communityReviewTasks.locationRadiusMeters,
    }).from(communityReviewTasks).where(and(
      eq(communityReviewTasks.id, parsed.data.review_task_id),
      eq(communityReviewTasks.placeId, place.id),
      or(eq(communityReviewTasks.status, 'pending_review'), eq(communityReviewTasks.status, 'conflicting')),
    )).for('update').limit(1))[0] : undefined;
    if (parsed.data.review_task_id && !reviewTask) return { kind: 'review_task_invalid' } as const;
    const distance = haversineMeters(parsed.data.latitude, parsed.data.longitude, Number(place.latitude), Number(place.longitude));
    const radiusMeters = reviewTask?.locationRadiusMeters ?? 200;
    const { passed, distanceBucket: bucket } = evaluateLocationProof(distance, parsed.data.accuracy_meters, radiusMeters);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const [proof] = await tx.insert(locationProofs).values({
      installationId: account.id, placeId: place.id, reviewTaskId: reviewTask?.id, passed, distanceBucket: bucket, expiresAt,
    }).returning();
    return { kind: 'created', proof, place, passed, bucket, expiresAt, radiusMeters } as const;
  });
  if (result.kind === 'account_inactive') return fail(c, 403, 'ACCOUNT_NOT_ACTIVE', '匿名账户当前不可创建位置证明');
  if (result.kind === 'place_changed') return fail(c, 409, 'PLACE_STATE_CHANGED', '地点状态刚刚发生变化，请刷新地点后重新验证位置');
  if (result.kind === 'review_task_invalid') return fail(c, 409, 'REVIEW_TASK_NOT_ACTIVE', '复核任务不存在、地点不匹配或已经结束');
  return ok(c, { proof_id: result.proof?.id, canonical_place_id: result.place.id, review_task_id: result.proof?.reviewTaskId, passed: result.passed, distance_bucket: result.bucket, radius_meters: result.radiusMeters, expires_at: result.expiresAt, privacy_notice: '精确坐标未保存，仅保留通过结果、粗粒度距离区间和校验时间。' });
});

reviewTasksRouter.get('/', async (c) => {
  const query = reviewTaskListSchema.safeParse(c.req.query());
  if (!query.success) return fail(c, 422, 'REVIEW_TASK_CURSOR_INVALID', '复核任务游标无效');
  const cursor = query.data.cursor ? decodeReviewTaskCursor(query.data.cursor) : undefined;
  if (query.data.cursor && !cursor) return fail(c, 422, 'REVIEW_TASK_CURSOR_INVALID', '复核任务游标无效');
  const activeCondition = or(
    eq(communityReviewTasks.status, 'pending_review'),
    eq(communityReviewTasks.status, 'conflicting'),
  )!;
  const independentReviewerCondition = or(
    ne(communityReviewTasks.targetType, 'observation'),
    isNull(observations.installationId),
    ne(observations.installationId, c.get('installationId')),
  )!;
  const cursorCondition = cursor ? or(
    lt(communityReviewTasks.createdAt, cursor.createdAt),
    and(
      eq(communityReviewTasks.createdAt, cursor.createdAt),
      lt(communityReviewTasks.id, cursor.id),
    ),
  ) : undefined;
  const rows = await db.select({
    id: communityReviewTasks.id,
    status: communityReviewTasks.status,
    reason: communityReviewTasks.reason,
    target_type: communityReviewTasks.targetType,
    target_id: communityReviewTasks.targetId,
    location_radius_meters: communityReviewTasks.locationRadiusMeters,
    feature_key: featureDefinitions.featureKey,
    feature_name: featureDefinitions.displayName,
    feature_unit: featureDefinitions.unit,
    place_id: places.id,
    place_name: places.name,
    address: places.address,
    historical_value: observations.valueJson,
    historical_source: observations.evidenceSource,
    historical_grade: observations.evidenceGrade,
    historical_freshness_status: observations.freshnessStatus,
    historical_moderation_status: observations.moderationStatus,
    historical_observed_at: observations.observedAt,
    historical_expires_at: observations.expiresAt,
    historical_has_redacted_media: sql<boolean>`EXISTS (
      SELECT 1 FROM ${observationMedia}
      INNER JOIN ${evidenceMedia} ON ${evidenceMedia.id} = ${observationMedia.mediaId}
      WHERE ${observationMedia.observationId} = ${observations.id}
        AND ${evidenceMedia.redactionConfirmed} = TRUE
        AND ${evidenceMedia.status} = 'linked'
        AND ${evidenceMedia.deletedAt} IS NULL
    )`,
    created_at: communityReviewTasks.createdAt,
  }).from(communityReviewTasks)
    .innerJoin(places, eq(communityReviewTasks.placeId, places.id))
    .innerJoin(featureDefinitions, eq(communityReviewTasks.featureDefinitionId, featureDefinitions.id))
    .leftJoin(observations, and(
      eq(communityReviewTasks.targetType, 'observation'),
      eq(communityReviewTasks.targetId, observations.id),
    ))
    .where(and(
      activeCondition,
      eq(places.status, 'active'),
      independentReviewerCondition,
      or(
        ne(communityReviewTasks.targetType, 'observation'),
        and(eq(observations.moderationStatus, 'approved'), isNull(observations.withdrawnAt)),
      ),
      cursorCondition,
    ))
    .orderBy(desc(communityReviewTasks.createdAt), desc(communityReviewTasks.id)).limit(51);
  const items = rows.slice(0, 50);
  const last = items.at(-1);
  return ok(c, {
    items,
    next_cursor: rows.length > 50 && last ? encodeReviewTaskCursor(last.created_at, last.id) : null,
  });
});

reviewTasksRouter.get('/:id/my-submission', async (c) => {
  const taskId = c.req.param('id');
  if (!z.uuid().safeParse(taskId).success) return fail(c, 422, 'REVIEW_TASK_ID_INVALID', '复核任务 ID 无效');
  const query = mySubmissionQuerySchema.safeParse(c.req.query());
  if (!query.success) return fail(c, 422, 'REVIEW_SUBMISSION_ID_INVALID', '复核提交 ID 无效');
  const [row] = await db.select({
    finalWeight: communityReviewVotes.finalWeight,
    consensusSnapshot: communityReviewTasks.consensusSnapshot,
  }).from(communityReviewVotes)
    .innerJoin(communityReviewTasks, eq(communityReviewVotes.reviewTaskId, communityReviewTasks.id))
    .where(and(
      eq(communityReviewVotes.reviewTaskId, taskId),
      eq(communityReviewVotes.installationId, c.get('installationId')),
      eq(communityReviewVotes.clientSubmissionId, query.data.submission_id),
    )).limit(1);
  if (!row) return fail(c, 404, 'REVIEW_SUBMISSION_NOT_FOUND', '尚未找到你的本轮复核结果', { retryable: true });
  const consensus = sanitizeStoredConsensusSnapshot(row.consensusSnapshot);
  if (!consensus) return fail(c, 409, 'REVIEW_SUBMISSION_PENDING', '复核结果仍在收敛，请稍后查询', { retryable: true });
  return ok(c, { vote_weight: Number(row.finalWeight), consensus });
});

reviewTasksRouter.post('/:id/submissions', async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'REVIEW_TASK_ID_INVALID', '复核任务 ID 无效');
  const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'REVIEW_VOTE_INVALID', '复核结果无效');
  const env = getEnv();
  const realIp = c.req.header('x-real-ip');
  const forwardedFor = c.req.header('x-forwarded-for');
  const sourceFingerprint = fingerprintCommunityReviewSource({
    trustProxy: env.TRUST_PROXY,
    ...(realIp ? { realIp } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
  }, env.AUTH_TOKEN_SECRET);
  let permit;
  try {
    permit = await consumeCommunityReviewPermit(c.get('installationId'), sourceFingerprint);
  } catch (error) {
    if (error instanceof CommunityReviewProtectionUnavailableError) {
      return fail(c, 503, 'COMMUNITY_REVIEW_PROTECTION_UNAVAILABLE', '社区复核保护暂不可用，请稍后重试', { retryable: true });
    }
    throw error;
  }
  if (!permit.allowed) {
    c.header('Retry-After', String(permit.retryAfterSeconds));
    return fail(c, 429, 'COMMUNITY_REVIEW_RATE_LIMITED', '复核提交过于频繁，请稍后再试', { retryable: true });
  }
  const [taskReference] = await db.select({ placeId: communityReviewTasks.placeId })
    .from(communityReviewTasks).where(eq(communityReviewTasks.id, c.req.param('id'))).limit(1);
  if (!taskReference) return fail(c, 404, 'REVIEW_TASK_NOT_FOUND', '复核任务不存在或已结束');
  const outcome = await db.transaction(async (tx) => {
    const now = new Date();
    const [account] = await tx.select().from(installationAccounts)
      .where(eq(installationAccounts.id, c.get('installationId'))).for('update').limit(1);
    if (!account || account.status !== 'active') return { kind: 'account_inactive' } as const;
    const [replayedVote] = await tx.select({
      finalWeight: communityReviewVotes.finalWeight,
    }).from(communityReviewVotes).where(and(
      eq(communityReviewVotes.reviewTaskId, c.req.param('id')),
      eq(communityReviewVotes.installationId, account.id),
      eq(communityReviewVotes.clientSubmissionId, parsed.data.submission_id),
    )).for('update').limit(1);
    if (replayedVote) {
      const [replayedTask] = await tx.select({ consensusSnapshot: communityReviewTasks.consensusSnapshot })
        .from(communityReviewTasks).where(eq(communityReviewTasks.id, c.req.param('id'))).limit(1);
      const consensus = sanitizeStoredConsensusSnapshot(replayedTask?.consensusSnapshot);
      if (consensus) return { kind: 'replayed', voteWeight: Number(replayedVote.finalWeight), consensus } as const;
    }
    const [activePlace] = await tx.select({ id: places.id }).from(places).where(and(
      eq(places.id, taskReference.placeId),
      eq(places.status, 'active'),
    )).for('update').limit(1);
    if (!activePlace) return { kind: 'place_inactive' } as const;
    const [reviewTask] = await tx.select().from(communityReviewTasks).where(and(
      eq(communityReviewTasks.id, c.req.param('id')),
      eq(communityReviewTasks.placeId, activePlace.id),
      or(eq(communityReviewTasks.status, 'pending_review'), eq(communityReviewTasks.status, 'conflicting')),
    )).for('update').limit(1);
    if (!reviewTask) return { kind: 'not_found' } as const;
    if (reviewTask.targetType === 'observation') {
      const [targetObservation] = await tx.select({
        installationId: observations.installationId,
        moderationStatus: observations.moderationStatus,
        withdrawnAt: observations.withdrawnAt,
      })
        .from(observations).where(eq(observations.id, reviewTask.targetId)).limit(1);
      if (!targetObservation || targetObservation.moderationStatus !== 'approved' || targetObservation.withdrawnAt) {
        return { kind: 'target_unavailable' } as const;
      }
      if (targetObservation?.installationId === account.id) return { kind: 'original_author' } as const;
    }
    const [existingVote] = await tx.select({ id: communityReviewVotes.id, mediaId: communityReviewVotes.mediaId })
      .from(communityReviewVotes)
      .where(and(
        eq(communityReviewVotes.reviewTaskId, reviewTask.id),
        eq(communityReviewVotes.installationId, account.id),
      ))
      .for('update')
      .limit(1);
    const claimedProof = parsed.data.location_proof_id ? (await tx.update(locationProofs).set({ consumedAt: now }).where(and(
      eq(locationProofs.id, parsed.data.location_proof_id),
      eq(locationProofs.installationId, account.id),
      eq(locationProofs.placeId, reviewTask.placeId),
      eq(locationProofs.reviewTaskId, reviewTask.id),
      gt(locationProofs.expiresAt, now),
      isNull(locationProofs.consumedAt),
    )).returning())[0] : undefined;
    if (parsed.data.location_proof_id && !claimedProof) throw new CommunityConflictError('LOCATION_PROOF_ALREADY_USED');
    const media = parsed.data.media_id
      ? existingVote?.mediaId === parsed.data.media_id
        ? (await tx.select().from(evidenceMedia).where(and(
            eq(evidenceMedia.id, parsed.data.media_id),
            eq(evidenceMedia.installationId, account.id),
            eq(evidenceMedia.status, 'linked'),
            eq(evidenceMedia.redactionConfirmed, true),
            or(isNull(evidenceMedia.expiresAt), gt(evidenceMedia.expiresAt, now)),
            isNull(evidenceMedia.deletedAt),
          )).limit(1))[0]
        : (await tx.update(evidenceMedia).set({
            status: 'linked',
            linkedAt: now,
            expiresAt: new Date(now.getTime() + COMMUNITY_REVIEW_MEDIA_RETENTION_MS),
            updatedAt: now,
          }).where(and(
            eq(evidenceMedia.id, parsed.data.media_id),
            eq(evidenceMedia.installationId, account.id),
            eq(evidenceMedia.status, 'pending_link'),
            eq(evidenceMedia.redactionConfirmed, true),
            gt(evidenceMedia.expiresAt, now),
            isNull(evidenceMedia.deletedAt),
          )).returning())[0]
      : undefined;
    if (parsed.data.media_id && !media) throw new CommunityConflictError('MEDIA_ALREADY_LINKED');
    if (existingVote?.mediaId && existingVote.mediaId !== media?.id) {
      const [observationReference] = await tx.select({ id: observationMedia.observationId }).from(observationMedia)
        .where(eq(observationMedia.mediaId, existingVote.mediaId)).limit(1);
      const [otherVoteReference] = await tx.select({ id: communityReviewVotes.id }).from(communityReviewVotes).where(and(
        eq(communityReviewVotes.mediaId, existingVote.mediaId),
        ne(communityReviewVotes.id, existingVote.id),
      )).limit(1);
      if (!observationReference && !otherVoteReference) {
        await tx.update(evidenceMedia).set({ status: 'withdrawn', expiresAt: now, updatedAt: now }).where(and(
          eq(evidenceMedia.id, existingVote.mediaId),
          eq(evidenceMedia.installationId, account.id),
          isNull(evidenceMedia.deletedAt),
        ));
      }
    }
    const duplicateMediaVotes = media?.fingerprintHmac
      ? await tx.select({ id: communityReviewVotes.id }).from(communityReviewVotes)
          .innerJoin(evidenceMedia, eq(communityReviewVotes.mediaId, evidenceMedia.id))
          .where(and(
            eq(communityReviewVotes.reviewTaskId, reviewTask.id),
            ne(communityReviewVotes.installationId, account.id),
            eq(evidenceMedia.fingerprintHmac, media.fingerprintHmac),
            isNull(evidenceMedia.deletedAt),
          ))
      : [];
    if (duplicateMediaVotes.length > 0) {
      await tx.update(communityReviewVotes).set({ suspended: true, updatedAt: now })
        .where(inArray(communityReviewVotes.id, duplicateMediaVotes.map((vote) => vote.id)));
    }
    const riskFlags = [
      ...(permit.suspiciousSource ? ['high_source_installation_churn'] : []),
      ...(duplicateMediaVotes.length > 0 ? ['duplicate_media'] : []),
    ];
    const suspended = riskFlags.length > 0;
    const voteInput: ReviewVoteInput = {
      installationId: account.id,
      answer: parsed.data.answer,
      submittedAt: now,
      accountCreatedAt: account.createdAt,
      hasAcceptedHistory: account.acceptedContributionCount > 0,
      hasConfirmedRedactedMedia: Boolean(media?.redactionConfirmed),
      locationProofPassed: claimedProof?.passed ?? false,
      suspended,
    };
    const weighted = calculateVoteWeight(voteInput);
    await tx.insert(communityReviewVotes).values({
      reviewTaskId: reviewTask.id,
      installationId: account.id,
      clientSubmissionId: parsed.data.submission_id,
      answer: parsed.data.answer,
      mediaId: media?.id ?? null,
      locationProofPassed: claimedProof?.passed ?? false,
      locationDistanceBucket: claimedProof?.distanceBucket ?? null,
      baseWeight: String(media ? claimedProof?.passed ? 1 : 0.8 : 0.5),
      finalWeight: String(weighted.weight),
      established: weighted.established,
      suspended,
    }).onConflictDoUpdate({
      target: [communityReviewVotes.reviewTaskId, communityReviewVotes.installationId],
      set: {
        clientSubmissionId: parsed.data.submission_id,
        answer: parsed.data.answer,
        mediaId: media?.id ?? null,
        locationProofPassed: claimedProof?.passed ?? false,
        locationDistanceBucket: claimedProof?.distanceBucket ?? null,
        baseWeight: String(media ? claimedProof?.passed ? 1 : 0.8 : 0.5),
        finalWeight: String(weighted.weight),
        established: weighted.established,
        suspended,
        updatedAt: now,
      },
    });
    const result = await recomputeCommunityConsensus(tx, reviewTask.id);
    await tx.update(communityReviewTasks).set({
      status: result.status,
      consensusOutcome: result.outcome,
      consensusSnapshot: toPublicConsensusSnapshot(result),
      updatedAt: now,
    }).where(eq(communityReviewTasks.id, reviewTask.id));
    if (reviewTask.targetType === 'observation') {
      if (result.status === 'community_consensus' && result.outcome === 'present') {
        await tx.update(observations).set({
          freshnessStatus: 'current', evidenceGrade: 'B', expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), updatedAt: now,
        }).where(and(eq(observations.id, reviewTask.targetId), eq(observations.moderationStatus, 'approved'), isNull(observations.withdrawnAt)));
      } else if (result.status === 'community_consensus' || result.status === 'conflicting') {
        await tx.update(observations).set({
          freshnessStatus: result.status === 'conflicting' ? 'conflicting' : 'expired', evidenceGrade: 'U', expiresAt: now, updatedAt: now,
        }).where(and(eq(observations.id, reviewTask.targetId), eq(observations.moderationStatus, 'approved'), isNull(observations.withdrawnAt)));
      }
    }
    await tx.insert(auditEvents).values({
      actorType: 'installation', actorId: account.id, action: 'community_review.submitted', targetType: 'community_review_task', targetId: reviewTask.id,
      metadata: {
        status: result.status,
        outcome: result.outcome,
        vote_weight: weighted.weight,
        policy_version: result.snapshot.version,
        risk_flags: riskFlags,
      },
      requestId: c.get('requestId'),
    });
    return { kind: 'recorded', weighted, result } as const;
  }).catch((error: unknown) => {
    if (error instanceof CommunityConflictError && error.code === 'MEDIA_ALREADY_LINKED') return { kind: 'media_invalid' } as const;
    if (error instanceof CommunityConflictError && error.code === 'LOCATION_PROOF_ALREADY_USED') return { kind: 'proof_invalid' } as const;
    throw error;
  });
  if (outcome.kind === 'account_inactive') return fail(c, 409, 'ACCOUNT_NOT_ACTIVE', '匿名账户正在删除或已停用，无法提交复核');
  if (outcome.kind === 'replayed') return ok(c, { vote_weight: outcome.voteWeight, consensus: outcome.consensus }, '复核结果已记录');
  if (outcome.kind === 'place_inactive') return fail(c, 409, 'PLACE_NOT_ACTIVE', '地点已停用或合并，请刷新复核任务');
  if (outcome.kind === 'not_found') return fail(c, 404, 'REVIEW_TASK_NOT_FOUND', '复核任务不存在或已结束');
  if (outcome.kind === 'target_unavailable') return fail(c, 409, 'REVIEW_TARGET_UNAVAILABLE', '原证据已撤回、未批准或不可用，复核任务已失效');
  if (outcome.kind === 'original_author') return fail(c, 403, 'INDEPENDENT_REVIEW_REQUIRED', '原证据提交者不能参与自己的独立复核');
  if (outcome.kind === 'media_invalid') return fail(c, 409, 'MEDIA_REFERENCE_INVALID', '复核图片不存在、已过期或已被其他内容占用');
  if (outcome.kind === 'proof_invalid') return fail(c, 409, 'LOCATION_PROOF_INVALID', '位置证明不存在、已过期或已使用');
  return ok(c, { vote_weight: outcome.weighted.weight, consensus: toPublicConsensusSnapshot(outcome.result) }, '复核结果已记录');
});

function encodeReviewTaskCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeReviewTaskCursor(value: string): { createdAt: Date; id: string } | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const separator = decoded.indexOf('|');
    if (separator <= 0) return undefined;
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || !z.uuid().safeParse(id).success) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (value: number) => value * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

class CommunityConflictError extends Error {
  constructor(readonly code: 'LOCATION_PROOF_ALREADY_USED' | 'MEDIA_ALREADY_LINKED' | 'APPEAL_MEDIA_UNAVAILABLE' | 'ACCOUNT_NOT_ACTIVE' | 'PLACE_NOT_ACTIVE') {
    super(code);
  }
}
