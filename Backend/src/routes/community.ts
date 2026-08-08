import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { calculateConsensus, calculateVoteWeight, type ReviewVoteInput } from '../domain/consensus.js';
import {
  auditEvents,
  communityReviewTasks,
  communityReviewVotes,
  db,
  evidenceMedia,
  featureDefinitions,
  installationAccounts,
  locationProofs,
  observationMedia,
  observations,
  places,
} from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import type { AppBindings } from '../types.js';

const observationSchema = z.object({
  place_id: z.uuid(),
  place_unit_id: z.uuid().optional(),
  facility_id: z.uuid().optional(),
  feature_key: z.string().min(1).max(128),
  value: z.union([z.boolean(), z.number(), z.string(), z.record(z.string(), z.unknown())]),
  observed_at: z.iso.datetime().optional(),
  media_ids: z.array(z.uuid()).max(6).default([]),
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
  const [feature] = await db.select().from(featureDefinitions).where(and(eq(featureDefinitions.featureKey, input.feature_key), eq(featureDefinitions.active, true))).limit(1);
  if (!feature) return fail(c, 422, 'FEATURE_NOT_SUPPORTED', '该无障碍字段尚未配置');
  const mediaRows = input.media_ids.length === 0 ? [] : await Promise.all(input.media_ids.map(async (mediaId) => {
    const [media] = await db.select().from(evidenceMedia).where(and(eq(evidenceMedia.id, mediaId), eq(evidenceMedia.installationId, c.get('installationId')), eq(evidenceMedia.status, 'pending_link'), isNull(evidenceMedia.deletedAt))).limit(1);
    return media;
  }));
  if (mediaRows.some((media) => !media)) return fail(c, 422, 'MEDIA_REFERENCE_INVALID', '证据图片不存在或无权关联');
  const result = await db.transaction(async (tx) => {
    const [observation] = await tx.insert(observations).values({
      installationId: c.get('installationId'),
      placeId: input.place_id,
      placeUnitId: input.place_unit_id,
      facilityId: input.facility_id,
      featureDefinitionId: feature.id,
      valueJson: input.value,
      evidenceSource: 'community',
      moderationStatus: 'pending',
      evidenceGrade: 'U',
      observedAt: input.observed_at ? new Date(input.observed_at) : new Date(),
    }).returning();
    if (!observation) throw new Error('OBSERVATION_INSERT_FAILED');
    for (const media of mediaRows) {
      if (!media) continue;
      await tx.insert(observationMedia).values({ observationId: observation.id, mediaId: media.id });
      await tx.update(evidenceMedia).set({ status: 'linked', linkedAt: new Date(), expiresAt: null, updatedAt: new Date() }).where(eq(evidenceMedia.id, media.id));
    }
    await tx.insert(auditEvents).values({ actorType: 'installation', actorId: c.get('installationId'), action: 'observation.submitted', targetType: 'observation', targetId: observation.id, requestId: c.get('requestId') });
    return observation;
  });
  return ok(c, result, '现场观测已提交，待审核或社区复核', 201);
});

observationsRouter.post('/:id/withdraw', async (c) => {
  const [observation] = await db.select().from(observations).where(and(eq(observations.id, c.req.param('id')), eq(observations.installationId, c.get('installationId')), isNull(observations.withdrawnAt))).limit(1);
  if (!observation) return fail(c, 404, 'OBSERVATION_NOT_FOUND', '观测不存在或已撤回');
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(observations).set({ withdrawnAt: now, moderationStatus: 'withdrawn', updatedAt: now }).where(eq(observations.id, observation.id));
    const links = await tx.select({ mediaId: observationMedia.mediaId }).from(observationMedia).where(eq(observationMedia.observationId, observation.id));
    if (links.length > 0) await tx.update(evidenceMedia).set({ status: 'withdrawn', expiresAt: now, updatedAt: now }).where(inArray(evidenceMedia.id, links.map((link) => link.mediaId)));
    await tx.insert(auditEvents).values({ actorType: 'installation', actorId: c.get('installationId'), action: 'observation.withdrawn', targetType: 'observation', targetId: observation.id, requestId: c.get('requestId') });
  });
  return ok(c, { withdrawn: true });
});

locationProofsRouter.post('/verify', async (c) => {
  const parsed = proofSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'LOCATION_PROOF_INVALID', '位置证明参数无效');
  const [place] = await db.select({ id: places.id, latitude: places.latitude, longitude: places.longitude }).from(places).where(eq(places.id, parsed.data.place_id)).limit(1);
  if (!place) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在');
  const distance = haversineMeters(parsed.data.latitude, parsed.data.longitude, Number(place.latitude), Number(place.longitude));
  const effectiveDistance = distance + parsed.data.accuracy_meters;
  const passed = effectiveDistance <= 200;
  const bucket = effectiveDistance <= 50 ? 'within_50m' : effectiveDistance <= 200 ? 'within_200m' : effectiveDistance <= 1000 ? 'within_1km' : 'over_1km';
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const [proof] = await db.insert(locationProofs).values({ installationId: c.get('installationId'), placeId: place.id, passed, distanceBucket: bucket, expiresAt }).returning();
  return ok(c, { proof_id: proof?.id, passed, distance_bucket: bucket, expires_at: expiresAt, privacy_notice: '精确坐标未保存，仅保留通过结果和粗粒度距离区间。' });
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
