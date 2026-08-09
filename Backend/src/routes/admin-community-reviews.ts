import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdminPermission } from '../auth/admin-permission.js';
import { fail, ok } from '../lib/api-response.js';
import {
  decideAdminCommunityReview,
  auditAdminCommunityReviewMediaAccess,
  getAdminCommunityReview,
  getAdminCommunityReviewMedia,
  listAdminCommunityReviews,
  type CommunityReviewAdminResult,
} from '../services/admin-community-review.js';
import { readEvidenceFile } from '../services/media-storage.js';
import type { AppBindings } from '../types.js';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(10).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['pending_review', 'community_consensus', 'conflicting', 'admin_rejected', 'cancelled', 'reopened']).optional(),
});
const decisionSchema = z.object({
  action: z.enum(['reopen', 'reject', 'cancel']),
  expected_updated_at: z.iso.datetime(),
  reason: z.string().trim().min(6).max(1000),
});

export const adminCommunityReviewsRouter = new Hono<AppBindings>();

adminCommunityReviewsRouter.get('/', requireAdminPermission('reviews.read'), async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 422, 'COMMUNITY_REVIEW_LIST_INVALID', '社区复核筛选参数无效');
  return ok(c, await listAdminCommunityReviews({
    page: parsed.data.page,
    pageSize: parsed.data.page_size,
    ...(parsed.data.q ? { query: parsed.data.q } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  }));
});

adminCommunityReviewsRouter.get('/media/:id/content', requireAdminPermission('reviews.read'), requireAdminPermission('media.read'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'MEDIA_ID_INVALID', '证据媒体 ID 无效');
  const media = await getAdminCommunityReviewMedia(c.req.param('id'));
  if (!media) return fail(c, 404, 'MEDIA_NOT_FOUND', '本轮已关联的脱敏复核图片不存在');
  let bytes: Buffer;
  try {
    bytes = await readEvidenceFile(media.storagePath);
  } catch {
    return fail(c, 410, 'MEDIA_FILE_UNAVAILABLE', '复核图片已删除或不可用');
  }
  if (bytes.length !== media.byteSize) return fail(c, 409, 'MEDIA_FILE_SIZE_MISMATCH', '复核图片与数据库记录不一致');
  await auditAdminCommunityReviewMediaAccess({
    actorId: c.get('adminUserId'),
    mediaId: media.id,
    reviewTaskId: media.reviewTaskId,
    requestId: c.get('requestId'),
  });
  c.header('Cache-Control', 'private, no-store');
  c.header('Content-Type', media.mimeType);
  c.header('Content-Length', String(bytes.length));
  c.header('Content-Disposition', `inline; filename="community-review-${media.id}"`);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', 'sandbox');
  return c.body(new Uint8Array(bytes));
});

adminCommunityReviewsRouter.get('/:id', requireAdminPermission('reviews.read'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'COMMUNITY_REVIEW_ID_INVALID', '社区复核任务 ID 无效');
  const result = await getAdminCommunityReview(c.req.param('id'));
  return result ? ok(c, result) : fail(c, 404, 'COMMUNITY_REVIEW_NOT_FOUND', '社区复核任务不存在');
});

adminCommunityReviewsRouter.post('/:id/decision', requireAdminPermission('reviews.decide'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'COMMUNITY_REVIEW_ID_INVALID', '社区复核任务 ID 无效');
  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'COMMUNITY_REVIEW_DECISION_INVALID', '处置动作、版本或理由无效');
  const result = await decideAdminCommunityReview({
    actorId: c.get('adminUserId'), taskId: c.req.param('id'), action: parsed.data.action,
    expectedUpdatedAt: new Date(parsed.data.expected_updated_at), reason: parsed.data.reason, requestId: c.get('requestId'),
  });
  return result.ok ? ok(c, result.value, '社区复核任务已处置') : decisionFailure(c, result);
});

function decisionFailure(c: Parameters<typeof fail>[0], result: Extract<CommunityReviewAdminResult<unknown>, { ok: false }>) {
  const status = result.code === 'COMMUNITY_REVIEW_NOT_FOUND' ? 404
    : result.code === 'COMMUNITY_REVIEW_CONFLICT' || result.code === 'COMMUNITY_REVIEW_ACTION_FORBIDDEN' ? 409
      : 422;
  return fail(c, status, result.code, result.message);
}
