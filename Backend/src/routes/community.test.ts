import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reviewGuard = vi.hoisted(() => ({
  consumeCommunityReviewPermit: vi.fn(),
  consumeLocationProofPermit: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireUser: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('installationId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
}));
vi.mock('../db/index.js', () => ({
  auditEvents: {},
  communityReviewTasks: {},
  communityReviewVotes: {},
  db: {},
  evidenceMedia: {},
  facilities: {},
  featureDefinitions: {},
  installationAccounts: {},
  locationProofs: {},
  observationMedia: {},
  observations: {},
  places: {},
  placeUnits: {},
  userFeedback: {},
}));
vi.mock('../config/env.js', () => ({
  getEnv: () => ({ TRUST_PROXY: true, AUTH_TOKEN_SECRET: 'a'.repeat(32) }),
}));
vi.mock('../services/community-review-guard.js', () => ({
  consumeCommunityReviewPermit: reviewGuard.consumeCommunityReviewPermit,
  consumeLocationProofPermit: reviewGuard.consumeLocationProofPermit,
  fingerprintCommunityReviewSource: vi.fn(() => 'network-fingerprint'),
  CommunityReviewProtectionUnavailableError: class extends Error {},
}));

import { locationProofsRouter, observationsRouter, reviewTasksRouter } from './community.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_community_test');
    await next();
  });
  app.route('/observations', observationsRouter);
  app.route('/review-tasks', reviewTasksRouter);
  app.route('/location-proofs', locationProofsRouter);
  return app;
}

describe('社区观测路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewGuard.consumeCommunityReviewPermit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, suspiciousSource: false });
    reviewGuard.consumeLocationProofPermit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, suspiciousSource: false });
  });
  it.each([
    { method: 'POST', path: '/observations/not-a-uuid/withdraw' },
    { method: 'GET', path: '/observations/not-a-uuid/moderation' },
    { method: 'POST', path: '/observations/not-a-uuid/appeals' },
    { method: 'POST', path: '/observations/not-a-uuid/supplements' },
  ])('非法观测 ID 在访问数据库前返回 422: $path', async ({ method, path }) => {
    const response = await testApp().request(path, { method });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('OBSERVATION_ID_INVALID');
  });

  it('非法复核任务 ID 在访问数据库前返回 422', async () => {
    const response = await testApp().request('/review-tasks/not-a-uuid/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        submission_id: '00000000-0000-4000-8000-000000000013',
        answer: 'present',
      }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('REVIEW_TASK_ID_INVALID');
  });

  it('位置证明中的非法复核任务 ID 在访问数据库前返回 422', async () => {
    const response = await testApp().request('/location-proofs/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        place_id: '00000000-0000-4000-8000-000000000011',
        review_task_id: 'not-a-uuid',
        latitude: 28.68,
        longitude: 115.86,
        accuracy_meters: 20,
      }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('LOCATION_PROOF_INVALID');
  });

  it('位置证明超限时返回 Retry-After 且不访问数据库', async () => {
    reviewGuard.consumeLocationProofPermit.mockResolvedValue({ allowed: false, retryAfterSeconds: 33, suspiciousSource: false });
    const response = await testApp().request('/location-proofs/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        place_id: '00000000-0000-4000-8000-000000000011',
        review_task_id: '00000000-0000-4000-8000-000000000012',
        latitude: 28.68,
        longitude: 115.86,
        accuracy_meters: 20,
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('33');
    expect((await response.json()).code).toBe('LOCATION_PROOF_RATE_LIMITED');
  });

  it('非法任务游标在访问数据库前返回 422', async () => {
    const response = await testApp().request('/review-tasks?cursor=not-a-cursor');
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('REVIEW_TASK_CURSOR_INVALID');
  });

  it('复核提交超限时返回 Retry-After 且不访问数据库', async () => {
    reviewGuard.consumeCommunityReviewPermit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42, suspiciousSource: false });
    const response = await testApp().request('/review-tasks/00000000-0000-4000-8000-000000000010/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        submission_id: '00000000-0000-4000-8000-000000000013',
        answer: 'present',
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect((await response.json()).code).toBe('COMMUNITY_REVIEW_RATE_LIMITED');
  });
});
