import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdminPermission } from '../auth/admin-permission.js';
import { fail, ok } from '../lib/api-response.js';
import {
  auditObservationMediaAccess,
  decideObservationReview,
  getObservationReviewDetail,
  getObservationReviewMedia,
  listAppeals,
  listObservationReviews,
  listVerificationReviews,
  resolveAppeal,
  reviewVerification,
  type ReviewResult,
} from '../services/admin-review.js';
import { readEvidenceFile } from '../services/media-storage.js';
import type { AppBindings } from '../types.js';

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const observationListSchema = paginationSchema.extend({
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
});
const observationDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'request_changes']),
  reason: z.string().trim().min(6).max(2000),
  expected_version: z.number().int().min(0),
});
const appealListSchema = paginationSchema.extend({
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']).optional(),
});
const appealDecisionSchema = z.object({
  decision: z.enum(['reopen', 'reject', 'request_more']),
  reason: z.string().trim().min(6).max(2000),
  expected_observation_version: z.number().int().min(0),
  expected_appeal_updated_at: z.iso.datetime(),
});
const verificationListSchema = paginationSchema.extend({
  status: z.enum(['unreviewed', 'confirmed', 'flagged']).optional(),
});
const verificationDecisionSchema = z.object({
  decision: z.enum(['confirm', 'flag']),
  reason: z.string().trim().min(6).max(2000),
  expected_updated_at: z.iso.datetime(),
});

export const adminReviewsRouter = new Hono<AppBindings>();

adminReviewsRouter.get('/observations', requireAdminPermission('reviews.read'), async (c) => {
  const parsed = observationListSchema.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 422, 'REVIEW_QUERY_INVALID', '审核队列筛选参数无效');
  return ok(c, await listObservationReviews({
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  }));
});

adminReviewsRouter.get('/observations/:id', requireAdminPermission('reviews.read'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'OBSERVATION_ID_INVALID', '证据观测 ID 无效');
  const detail = await getObservationReviewDetail(c.req.param('id'));
  return detail ? ok(c, detail) : fail(c, 404, 'OBSERVATION_NOT_FOUND', '证据观测不存在');
});

adminReviewsRouter.post('/observations/:id/decision', requireAdminPermission('reviews.decide'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'OBSERVATION_ID_INVALID', '证据观测 ID 无效');
  const parsed = observationDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'REVIEW_DECISION_INVALID', '审核结论、版本或理由无效');
  const result = await decideObservationReview({
    actorId: c.get('adminUserId'),
    observationId: c.req.param('id'),
    expectedVersion: parsed.data.expected_version,
    decision: parsed.data.decision,
    reason: parsed.data.reason,
    requestId: c.get('requestId'),
  });
  return result.ok ? ok(c, result.value, '审核决定已记录') : reviewFailure(c, result);
});

adminReviewsRouter.get('/appeals', requireAdminPermission('reviews.read'), async (c) => {
  const parsed = appealListSchema.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 422, 'APPEAL_QUERY_INVALID', '申诉队列筛选参数无效');
  return ok(c, await listAppeals({
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  }));
});

adminReviewsRouter.post('/appeals/:id/decision', requireAdminPermission('reviews.decide'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'APPEAL_ID_INVALID', '申诉 ID 无效');
  const parsed = appealDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'APPEAL_DECISION_INVALID', '申诉结论、版本或理由无效');
  const result = await resolveAppeal({
    actorId: c.get('adminUserId'),
    appealId: c.req.param('id'),
    expectedObservationVersion: parsed.data.expected_observation_version,
    expectedAppealUpdatedAt: new Date(parsed.data.expected_appeal_updated_at),
    decision: parsed.data.decision,
    reason: parsed.data.reason,
    requestId: c.get('requestId'),
  });
  return result.ok ? ok(c, result.value, '申诉处理已记录') : reviewFailure(c, result);
});

adminReviewsRouter.get('/verifications', requireAdminPermission('verifications.read'), async (c) => {
  const parsed = verificationListSchema.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 422, 'VERIFICATION_QUERY_INVALID', 'AI 验真筛选参数无效');
  return ok(c, await listVerificationReviews({
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  }));
});

adminReviewsRouter.post('/verifications/:id/decision', requireAdminPermission('reviews.decide'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'VERIFICATION_ID_INVALID', 'AI 验真记录 ID 无效');
  const parsed = verificationDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'VERIFICATION_DECISION_INVALID', 'AI 验真复核参数无效');
  const result = await reviewVerification({
    actorId: c.get('adminUserId'),
    verificationId: c.req.param('id'),
    expectedUpdatedAt: new Date(parsed.data.expected_updated_at),
    decision: parsed.data.decision,
    reason: parsed.data.reason,
    requestId: c.get('requestId'),
  });
  return result.ok ? ok(c, result.value, 'AI 验真人工复核已记录') : reviewFailure(c, result);
});

adminReviewsRouter.get('/media/:id/content', requireAdminPermission('media.read'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'MEDIA_ID_INVALID', '证据媒体 ID 无效');
  const media = await getObservationReviewMedia(c.req.param('id'));
  if (!media) return fail(c, 404, 'MEDIA_NOT_FOUND', '已关联的脱敏证据媒体不存在');
  let bytes: Buffer;
  try {
    bytes = await readEvidenceFile(media.storagePath);
  } catch {
    return fail(c, 410, 'MEDIA_FILE_UNAVAILABLE', '证据媒体文件已删除或不可用');
  }
  if (bytes.length !== media.byteSize) return fail(c, 409, 'MEDIA_FILE_SIZE_MISMATCH', '证据媒体文件与数据库记录不一致');
  await auditObservationMediaAccess({
    actorId: c.get('adminUserId'),
    mediaId: media.id,
    observationId: media.observationId,
    requestId: c.get('requestId'),
  });
  c.header('Cache-Control', 'private, no-store');
  c.header('Content-Type', media.mimeType);
  c.header('Content-Length', String(bytes.length));
  c.header('Content-Disposition', `inline; filename="evidence-${media.id}"`);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', 'sandbox');
  return c.body(new Uint8Array(bytes));
});

function reviewFailure(c: Parameters<typeof fail>[0], result: Extract<ReviewResult<unknown>, { ok: false }>) {
  const status = result.code.endsWith('_NOT_FOUND') ? 404
    : result.code.endsWith('_CONFLICT') || result.code.endsWith('_FORBIDDEN') ? 409
      : 422;
  return fail(c, status, result.code, result.message);
}
