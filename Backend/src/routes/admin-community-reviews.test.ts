import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  decideAdminCommunityReview: vi.fn(),
  auditAdminCommunityReviewMediaAccess: vi.fn(),
  getAdminCommunityReview: vi.fn(),
  getAdminCommunityReviewMedia: vi.fn(),
  listAdminCommunityReviews: vi.fn(),
}));
vi.mock('../services/admin-community-review.js', () => service);
vi.mock('../services/media-storage.js', () => ({ readEvidenceFile: vi.fn() }));

import { adminCommunityReviewsRouter } from './admin-community-reviews.js';
import { readEvidenceFile } from '../services/media-storage.js';
import type { AppBindings } from '../types.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TASK_ID = '00000000-0000-4000-8000-000000000010';
const UPDATED_AT = '2026-08-09T00:00:00.000Z';

function testApp(permissions: string[]) {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_community_admin_test');
    c.set('adminUserId', ADMIN_ID);
    c.set('adminPermissions', permissions);
    await next();
  });
  app.route('/community-reviews', adminCommunityReviewsRouter);
  return app;
}

describe('管理员社区复核路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listAdminCommunityReviews.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, summary: {} });
  });

  it('列表需要审核读取权限', async () => {
    const response = await testApp([]).request('/community-reviews');
    expect(response.status).toBe(403);
    expect(service.listAdminCommunityReviews).not.toHaveBeenCalled();
  });

  it('服务端分页、搜索与状态筛选传入查询服务', async () => {
    const response = await testApp(['reviews.read']).request('/community-reviews?page=2&page_size=50&q=elevator&status=conflicting');
    expect(response.status).toBe(200);
    expect(service.listAdminCommunityReviews).toHaveBeenCalledWith({ page: 2, pageSize: 50, query: 'elevator', status: 'conflicting' });
  });

  it('非法任务 ID 在访问服务前返回 422', async () => {
    const response = await testApp(['reviews.read']).request('/community-reviews/not-a-uuid');
    expect(response.status).toBe(422);
    expect(service.getAdminCommunityReview).not.toHaveBeenCalled();
  });

  it('处置需要 reviews.decide 权限', async () => {
    const response = await testApp(['reviews.read']).request(`/community-reviews/${TASK_ID}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', expected_updated_at: UPDATED_AT, reason: '现场复核结果冲突且证据不足' }),
    });
    expect(response.status).toBe(403);
    expect(service.decideAdminCommunityReview).not.toHaveBeenCalled();
  });

  it('复核图片读取同时需要审核读取和媒体读取权限', async () => {
    const response = await testApp(['reviews.read']).request(`/community-reviews/media/${TASK_ID}/content`);
    expect(response.status).toBe(403);
    expect(service.getAdminCommunityReviewMedia).not.toHaveBeenCalled();
  });

  it('读取脱敏复核图片禁止缓存并写入审计', async () => {
    service.getAdminCommunityReviewMedia.mockResolvedValue({
      id: TASK_ID, storagePath: 'review.webp', mimeType: 'image/webp', byteSize: 3, reviewTaskId: TASK_ID,
    });
    vi.mocked(readEvidenceFile).mockResolvedValue(Buffer.from([1, 2, 3]));
    const response = await testApp(['reviews.read', 'media.read']).request(`/community-reviews/media/${TASK_ID}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(service.auditAdminCommunityReviewMediaAccess).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN_ID, mediaId: TASK_ID, reviewTaskId: TASK_ID,
    }));
  });

  it('乐观锁冲突返回稳定 409 并传递操作理由', async () => {
    service.decideAdminCommunityReview.mockResolvedValue({ ok: false, code: 'COMMUNITY_REVIEW_CONFLICT', message: '任务已更新' });
    const response = await testApp(['reviews.decide']).request(`/community-reviews/${TASK_ID}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reopen', expected_updated_at: UPDATED_AT, reason: '需要发起全新轮次获取独立现场复核' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('COMMUNITY_REVIEW_CONFLICT');
    expect(service.decideAdminCommunityReview).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN_ID, taskId: TASK_ID, action: 'reopen', expectedUpdatedAt: new Date(UPDATED_AT),
      reason: '需要发起全新轮次获取独立现场复核',
    }));
  });
});
