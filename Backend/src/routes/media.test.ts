import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  updateValues: null as Record<string, unknown> | null,
  removeEvidenceFile: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
}));
vi.mock('../db/index.js', () => ({
  evidenceMedia: { id: {}, installationId: {}, deletedAt: {} },
  installationAccounts: { id: {}, status: {} },
  mediaUploadParts: { uploadId: {}, partNumber: {}, byteSize: {}, sha256: {} },
  mediaUploadSessions: { id: {}, installationId: {}, idempotencyKey: {}, expiresAt: {}, status: {} },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: '00000000-0000-4000-8000-000000000010',
            storagePath: 'one.webp',
          }]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          state.updateValues = values;
        }),
      })),
    })),
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireUser: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('installationId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
}));
vi.mock('../services/media-storage.js', () => ({
  MEDIA_MAX_PARTS: 10,
  MEDIA_PART_BYTES: 1024 * 1024,
  assembleEvidenceFile: vi.fn(),
  mediaDiskUsageBytes: vi.fn(),
  removeEvidenceFile: state.removeEvidenceFile,
  removeUploadDirectory: vi.fn(),
  writeUploadPart: vi.fn(),
}));

import { mediaRouter } from './media.js';
import type { AppBindings } from '../types.js';

describe('用户媒体删除', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.updateValues = null;
    state.removeEvidenceFile.mockResolvedValue(undefined);
  });

  it('物理删除后同步清空 HMAC 指纹和密钥版本', async () => {
    const app = new Hono<AppBindings>();
    app.route('/media', mediaRouter);

    const response = await app.request('/media/00000000-0000-4000-8000-000000000010', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(state.removeEvidenceFile).toHaveBeenCalledWith('one.webp');
    expect(state.updateValues).toMatchObject({
      status: 'deleted',
      fingerprintHmac: null,
      fingerprintKeyVersion: null,
    });
    expect(state.updateValues?.deletedAt).toBeInstanceOf(Date);
  });
});
