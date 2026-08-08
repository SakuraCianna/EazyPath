import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reviewService = vi.hoisted(() => ({
  auditObservationMediaAccess: vi.fn(),
  decideObservationReview: vi.fn(),
  getObservationReviewDetail: vi.fn(),
  getObservationReviewMedia: vi.fn(),
  listAppeals: vi.fn(),
  listObservationReviews: vi.fn(),
  listVerificationReviews: vi.fn(),
  resolveAppeal: vi.fn(),
  reviewVerification: vi.fn(),
}));
const mediaStorage = vi.hoisted(() => ({ readEvidenceFile: vi.fn() }));

vi.mock('../services/admin-review.js', () => reviewService);
vi.mock('../services/media-storage.js', () => mediaStorage);

import { adminReviewsRouter } from './admin-reviews.js';
import type { AppBindings } from '../types.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const OBSERVATION_ID = '00000000-0000-4000-8000-000000000010';
const MEDIA_ID = '00000000-0000-4000-8000-000000000020';
const VERIFICATION_ID = '00000000-0000-4000-8000-000000000030';
const APPEAL_ID = '00000000-0000-4000-8000-000000000040';

function testApp(permissions: string[]) {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_review_test');
    c.set('adminUserId', ADMIN_ID);
    c.set('adminPermissions', permissions);
    await next();
  });
  app.route('/reviews', adminReviewsRouter);
  return app;
}

describe('管理员审核路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewService.listObservationReviews.mockResolvedValue({ items: [], total: 0, limit: 30, offset: 0 });
    reviewService.listVerificationReviews.mockResolvedValue({ items: [], total: 0, limit: 30, offset: 0 });
  });

  it('缺少审核读取权限时拒绝访问且不查询数据', async () => {
    const response = await testApp([]).request('/reviews/observations');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('ADMIN_PERMISSION_DENIED');
    expect(reviewService.listObservationReviews).not.toHaveBeenCalled();
  });

  it('审核队列校验分页和状态后透传到服务层', async () => {
    const response = await testApp(['reviews.read']).request('/reviews/observations?status=pending&limit=20&offset=10');

    expect(response.status).toBe(200);
    expect(reviewService.listObservationReviews).toHaveBeenCalledWith({ status: 'pending', limit: 20, offset: 10 });
  });

  it('审核版本冲突返回 409 并保留稳定错误码', async () => {
    reviewService.decideObservationReview.mockResolvedValue({
      ok: false,
      code: 'OBSERVATION_REVIEW_CONFLICT',
      message: '证据已被其他管理员更新，请刷新后重试',
    });
    const response = await testApp(['reviews.decide']).request(`/reviews/observations/${OBSERVATION_ID}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reason: '脱敏图片清晰且与地点和字段一致', expected_version: 2 }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('OBSERVATION_REVIEW_CONFLICT');
    expect(reviewService.decideObservationReview).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN_ID,
      observationId: OBSERVATION_ID,
      expectedVersion: 2,
      decision: 'approve',
    }));
  });

  it('AI 验真复核要求写权限并传递乐观锁时间', async () => {
    reviewService.reviewVerification.mockResolvedValue({
      ok: true,
      value: { id: VERIFICATION_ID, adminReviewStatus: 'confirmed', updatedAt: new Date('2026-08-09T01:00:00.000Z') },
    });
    const response = await testApp(['reviews.decide']).request(`/reviews/verifications/${VERIFICATION_ID}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'confirm',
        reason: '模型结果与脱敏证据内容一致，可以确认',
        expected_updated_at: '2026-08-09T00:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(reviewService.reviewVerification).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN_ID,
      verificationId: VERIFICATION_ID,
      expectedUpdatedAt: new Date('2026-08-09T00:00:00.000Z'),
      decision: 'confirm',
    }));
  });

  it('申诉决策同时传递观测版本和申诉更新时间冲突令牌', async () => {
    reviewService.resolveAppeal.mockResolvedValue({
      ok: false,
      code: 'APPEAL_REVIEW_CONFLICT',
      message: '申诉已被其他管理员更新，请刷新后重试',
    });
    const response = await testApp(['reviews.decide']).request(`/reviews/appeals/${APPEAL_ID}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'request_more',
        reason: '请补充能够看清入口门槛和坡道全貌的照片',
        expected_observation_version: 3,
        expected_appeal_updated_at: '2026-08-09T00:00:00.000Z',
      }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('APPEAL_REVIEW_CONFLICT');
    expect(reviewService.resolveAppeal).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN_ID,
      appealId: APPEAL_ID,
      expectedObservationVersion: 3,
      expectedAppealUpdatedAt: new Date('2026-08-09T00:00:00.000Z'),
      decision: 'request_more',
    }));
  });

  it('只向有媒体权限的管理员返回已确认脱敏文件并记录访问审计', async () => {
    reviewService.getObservationReviewMedia.mockResolvedValue({
      id: MEDIA_ID,
      observationId: OBSERVATION_ID,
      storagePath: 'evidence-file.webp',
      mimeType: 'image/webp',
      byteSize: 4,
    });
    mediaStorage.readEvidenceFile.mockResolvedValue(Buffer.from([1, 2, 3, 4]));
    reviewService.auditObservationMediaAccess.mockResolvedValue(undefined);

    const response = await testApp(['media.read']).request(`/reviews/media/${MEDIA_ID}/content`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toContain('image/webp');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(reviewService.auditObservationMediaAccess).toHaveBeenCalledWith({
      actorId: ADMIN_ID,
      mediaId: MEDIA_ID,
      observationId: OBSERVATION_ID,
      requestId: 'req_review_test',
    });
  });

  it('数据库记录存在但文件已清理时返回 410 且不写访问审计', async () => {
    reviewService.getObservationReviewMedia.mockResolvedValue({
      id: MEDIA_ID,
      observationId: OBSERVATION_ID,
      storagePath: 'missing.webp',
      mimeType: 'image/webp',
      byteSize: 4,
    });
    mediaStorage.readEvidenceFile.mockRejectedValue(new Error('missing'));

    const response = await testApp(['media.read']).request(`/reviews/media/${MEDIA_ID}/content`);

    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('MEDIA_FILE_UNAVAILABLE');
    expect(reviewService.auditObservationMediaAccess).not.toHaveBeenCalled();
  });
});
