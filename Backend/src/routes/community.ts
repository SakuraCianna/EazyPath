import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { calculateConsensus, calculateVoteWeight, type ReviewVoteInput } from '../domain/consensus.js';
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
import { lockCanonicalPlace, resolveActivePlace } from '../services/place-resolution.js';
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
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy_meters: z.number().positive().max(500),
});

const voteSchema = z.object({
  answer: z.enum(['present', 'absent', 'unknown']),
  media_id: z.uuid().optional(),
  location_proof_id: z.uuid().optional(),
});

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
    const [observation] = await tx.select().from(observations).where(and(
    eq(observations.id, c.req.param('id')),
    eq(observations.installationId, c.get('installationId')),
    eq(observations.evidenceSource, 'community'),
    isNull(observations.withdrawnAt),
    )).for('update').limit(1);
    if (!observation) return false;
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
  const candidate = await resolveActivePlace(parsed.data.place_id);
  if (!candidate) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在或已停用');
  const result = await db.transaction(async (tx) => {
    const place = await lockCanonicalPlace(tx, candidate.id);
    if (!place) return undefined;
    const distance = haversineMeters(parsed.data.latitude, parsed.data.longitude, Number(place.latitude), Number(place.longitude));
    const effectiveDistance = distance + parsed.data.accuracy_meters;
    const passed = effectiveDistance <= 200;
    const bucket = effectiveDistance <= 50 ? 'within_50m' : effectiveDistance <= 200 ? 'within_200m' : effectiveDistance <= 1000 ? 'within_1km' : 'over_1km';
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const [proof] = await tx.insert(locationProofs).values({ installationId: c.get('installationId'), placeId: place.id, passed, distanceBucket: bucket, expiresAt }).returning();
    return { proof, place, passed, bucket, expiresAt };
  });
  if (!result) return fail(c, 409, 'PLACE_STATE_CHANGED', '地点状态刚刚发生变化，请刷新地点后重新验证位置');
  return ok(c, { proof_id: result.proof?.id, canonical_place_id: result.place.id, passed: result.passed, distance_bucket: result.bucket, expires_at: result.expiresAt, privacy_notice: '精确坐标未保存，仅保留通过结果和粗粒度距离区间。' });
});

reviewTasksRouter.get('/', async (c) => {
  const rows = await db.select({
    id: communityReviewTasks.id,
    status: communityReviewTasks.status,
    reason: communityReviewTasks.reason,
    target_type: communityReviewTasks.targetType,
    target_id: communityReviewTasks.targetId,
    location_radius_meters: communityReviewTasks.locationRadiusMeters,
    feature_key: featureDefinitions.featureKey,
    feature_name: featureDefinitions.displayName,
    place_id: places.id,
    place_name: places.name,
    address: places.address,
    created_at: communityReviewTasks.createdAt,
  }).from(communityReviewTasks).innerJoin(places, eq(communityReviewTasks.placeId, places.id)).innerJoin(featureDefinitions, eq(communityReviewTasks.featureDefinitionId, featureDefinitions.id)).where(or(eq(communityReviewTasks.status, 'pending_review'), eq(communityReviewTasks.status, 'conflicting'))).orderBy(desc(communityReviewTasks.createdAt)).limit(50);
  return ok(c, rows);
});

reviewTasksRouter.post('/:id/submissions', async (c) => {
  const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'REVIEW_VOTE_INVALID', '复核结果无效');
  const [reviewTask] = await db.select().from(communityReviewTasks).where(and(eq(communityReviewTasks.id, c.req.param('id')), or(eq(communityReviewTasks.status, 'pending_review'), eq(communityReviewTasks.status, 'conflicting')))).limit(1);
  if (!reviewTask) return fail(c, 404, 'REVIEW_TASK_NOT_FOUND', '复核任务不存在或已结束');
  const [account] = await db.select().from(installationAccounts).where(eq(installationAccounts.id, c.get('installationId'))).limit(1);
  if (!account) return fail(c, 401, 'AUTH_TOKEN_INVALID', '安装账户无效');

  const media = parsed.data.media_id ? (await db.select().from(evidenceMedia).where(and(eq(evidenceMedia.id, parsed.data.media_id), eq(evidenceMedia.installationId, account.id), eq(evidenceMedia.status, 'linked'), isNull(evidenceMedia.deletedAt))).limit(1))[0] : undefined;
  if (parsed.data.media_id && !media) return fail(c, 422, 'MEDIA_REFERENCE_INVALID', '复核图片不存在或尚未关联');
  const proof = parsed.data.location_proof_id ? (await db.select().from(locationProofs).where(and(eq(locationProofs.id, parsed.data.location_proof_id), eq(locationProofs.installationId, account.id), eq(locationProofs.placeId, reviewTask.placeId), gt(locationProofs.expiresAt, new Date()), isNull(locationProofs.consumedAt))).limit(1))[0] : undefined;
  if (parsed.data.location_proof_id && !proof) return fail(c, 422, 'LOCATION_PROOF_INVALID', '位置证明不存在、已过期或已使用');

  const voteInput: ReviewVoteInput = {
    installationId: account.id,
    answer: parsed.data.answer,
    submittedAt: new Date(),
    accountCreatedAt: account.createdAt,
    hasAcceptedHistory: account.acceptedContributionCount > 0,
    hasConfirmedRedactedMedia: Boolean(media?.redactionConfirmed),
    locationProofPassed: proof?.passed ?? false,
    suspended: account.status !== 'active',
  };
  const weighted = calculateVoteWeight(voteInput);
  await db.insert(communityReviewVotes).values({
    reviewTaskId: reviewTask.id,
    installationId: account.id,
    answer: parsed.data.answer,
    mediaId: media?.id,
    locationProofPassed: proof?.passed ?? false,
    locationDistanceBucket: proof?.distanceBucket,
    baseWeight: String(media ? proof?.passed ? 1 : 0.8 : 0.5),
    finalWeight: String(weighted.weight),
    suspended: weighted.suspended,
  }).onConflictDoUpdate({
    target: [communityReviewVotes.reviewTaskId, communityReviewVotes.installationId],
    set: {
      answer: parsed.data.answer,
      mediaId: media?.id,
      locationProofPassed: proof?.passed ?? false,
      locationDistanceBucket: proof?.distanceBucket,
      baseWeight: String(media ? proof?.passed ? 1 : 0.8 : 0.5),
      finalWeight: String(weighted.weight),
      suspended: weighted.suspended,
      updatedAt: new Date(),
    },
  });
  if (proof) await db.update(locationProofs).set({ consumedAt: new Date() }).where(eq(locationProofs.id, proof.id));

  const result = await recomputeConsensus(reviewTask.id);
  await db.update(communityReviewTasks).set({ status: result.status, consensusOutcome: result.outcome, consensusSnapshot: result, updatedAt: new Date() }).where(eq(communityReviewTasks.id, reviewTask.id));
  await db.insert(auditEvents).values({ actorType: 'installation', actorId: account.id, action: 'community_review.submitted', targetType: 'community_review_task', targetId: reviewTask.id, metadata: { status: result.status }, requestId: c.get('requestId') });
  return ok(c, { vote_weight: weighted.weight, consensus: result }, '复核结果已记录');
});

async function recomputeConsensus(reviewTaskId: string) {
  const rows = await db.select({
    installationId: communityReviewVotes.installationId,
    answer: communityReviewVotes.answer,
    submittedAt: communityReviewVotes.updatedAt,
    accountCreatedAt: installationAccounts.createdAt,
    acceptedCount: installationAccounts.acceptedContributionCount,
    mediaConfirmed: evidenceMedia.redactionConfirmed,
    locationProofPassed: communityReviewVotes.locationProofPassed,
    suspended: communityReviewVotes.suspended,
  }).from(communityReviewVotes).innerJoin(installationAccounts, eq(communityReviewVotes.installationId, installationAccounts.id)).leftJoin(evidenceMedia, eq(communityReviewVotes.mediaId, evidenceMedia.id)).where(eq(communityReviewVotes.reviewTaskId, reviewTaskId));
  return calculateConsensus(rows.map((row) => ({
    installationId: row.installationId,
    answer: row.answer as 'present' | 'absent' | 'unknown',
    submittedAt: row.submittedAt,
    accountCreatedAt: row.accountCreatedAt,
    hasAcceptedHistory: row.acceptedCount > 0,
    hasConfirmedRedactedMedia: row.mediaConfirmed ?? false,
    locationProofPassed: row.locationProofPassed,
    suspended: row.suspended,
  })));
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
