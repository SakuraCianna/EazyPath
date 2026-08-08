import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

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

import { observationsRouter } from './community.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_community_test');
    await next();
  });
  app.route('/observations', observationsRouter);
  return app;
}

describe('社区观测路由', () => {
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
});
