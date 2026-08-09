import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  installationId: '00000000-0000-4000-8000-000000000001',
  requestedPlaceId: '00000000-0000-4000-8000-000000000010',
  canonicalPlaceId: '00000000-0000-4000-8000-000000000020',
  recordId: '00000000-0000-4000-8000-000000000030',
  temporaryPath: 'E:\\media\\temporary\\verification.upload',
}));
const placeResolution = vi.hoisted(() => ({ resolveActivePlace: vi.fn(), lockCanonicalPlace: vi.fn() }));
const mediaStorage = vi.hoisted(() => ({ saveTemporaryVerificationImage: vi.fn(), removeTemporaryVerificationImage: vi.fn() }));
const queue = vi.hoisted(() => ({ enqueueVisionVerification: vi.fn() }));
const database = vi.hoisted(() => {
  const insertedValues = vi.fn();
  const tx = {
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        insertedValues(values);
        return { returning: async () => [{ id: fixtures.recordId }] };
      },
    })),
  };
  return {
    insertedValues,
    tx,
    db: {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
      update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
    },
  };
});

vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('../config/env.js', () => ({ getEnv: () => ({ VISION_MODEL: 'qwen-vl-test' }) }));
vi.mock('../db/index.js', () => ({
  db: database.db,
  verificationRecords: { id: 'id', installationId: 'installation_id' },
}));
vi.mock('../middleware/auth.js', () => ({
  requireUser: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('installationId', fixtures.installationId);
    await next();
  },
}));
vi.mock('../queue/task-queue.js', () => queue);
vi.mock('../services/media-storage.js', () => mediaStorage);
vi.mock('../services/place-resolution.js', () => placeResolution);

import { verificationsRouter } from './verifications.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_verification_test');
    await next();
  });
  app.route('/verifications', verificationsRouter);
  return app;
}

function imageRequest(placeId?: string) {
  const body = new FormData();
  body.set('image', new File([new Uint8Array([1, 2, 3])], 'evidence.png', { type: 'image/png' }));
  if (placeId) body.set('place_id', placeId);
  return testApp().request('/verifications/images', { method: 'POST', body });
}

describe('AI 验真地点治理与临时文件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaStorage.saveTemporaryVerificationImage.mockResolvedValue(fixtures.temporaryPath);
    mediaStorage.removeTemporaryVerificationImage.mockResolvedValue(undefined);
    placeResolution.resolveActivePlace.mockResolvedValue({ id: fixtures.canonicalPlaceId, latitude: '28.6', longitude: '115.9' });
    placeResolution.lockCanonicalPlace.mockResolvedValue({ id: fixtures.canonicalPlaceId, latitude: '28.6', longitude: '115.9' });
    queue.enqueueVisionVerification.mockResolvedValue(undefined);
  });

  it('在写临时文件前拒绝非法地点 ID', async () => {
    const response = await imageRequest('not-a-uuid');
    expect(response.status).toBe(422);
    expect(mediaStorage.saveTemporaryVerificationImage).not.toHaveBeenCalled();
  });

  it('已停用或不存在的地点不会创建验真任务', async () => {
    placeResolution.resolveActivePlace.mockResolvedValue(undefined);
    const response = await imageRequest(fixtures.requestedPlaceId);
    expect(response.status).toBe(404);
    expect(mediaStorage.saveTemporaryVerificationImage).not.toHaveBeenCalled();
    expect(database.db.transaction).not.toHaveBeenCalled();
  });

  it('保存图片后地点状态变化会返回 409 并删除临时文件', async () => {
    placeResolution.lockCanonicalPlace.mockResolvedValue(undefined);
    const response = await imageRequest(fixtures.requestedPlaceId);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('PLACE_STATE_CHANGED');
    expect(mediaStorage.removeTemporaryVerificationImage).toHaveBeenCalledWith(fixtures.temporaryPath);
    expect(queue.enqueueVisionVerification).not.toHaveBeenCalled();
  });

  it('写入 canonical 地点且队列不可用时删除临时文件', async () => {
    queue.enqueueVisionVerification.mockRejectedValue(new Error('redis unavailable'));
    const response = await imageRequest(fixtures.requestedPlaceId);
    expect(response.status).toBe(503);
    expect(database.insertedValues).toHaveBeenCalledWith(expect.objectContaining({ placeId: fixtures.canonicalPlaceId }));
    expect(mediaStorage.removeTemporaryVerificationImage).toHaveBeenCalledWith(fixtures.temporaryPath);
  });
});
