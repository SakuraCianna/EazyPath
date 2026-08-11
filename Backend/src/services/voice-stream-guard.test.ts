import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  eval: vi.fn(),
  quit: vi.fn(async () => 'OK'),
  disconnect: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: class {
    eval(...arguments_: unknown[]) { return redis.eval(...arguments_); }
    on() { return this; }
    quit() { return redis.quit(); }
    disconnect() { return redis.disconnect(); }
  },
}));
vi.mock('../config/env.js', () => ({ getEnv: () => ({ REDIS_URL: 'redis://localhost:6379' }) }));

import { acquireVoiceStreamPermit, closeVoiceStreamGuard, VoiceStreamProtectionUnavailableError } from './voice-stream-guard.js';

describe('语音 WebSocket Redis 租约', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => closeVoiceStreamGuard());

  it('同一安装账户取得租约后可显式释放', async () => {
    redis.eval.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const permit = await acquireVoiceStreamPermit('00000000-0000-4000-8000-000000000001');
    expect(permit.allowed).toBe(true);
    await permit.refresh();
    await permit.release();
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it('超限返回有界重试时间', async () => {
    redis.eval.mockResolvedValueOnce([0, 2_500]);
    const permit = await acquireVoiceStreamPermit('00000000-0000-4000-8000-000000000001');
    expect(permit).toMatchObject({ allowed: false, retryAfterSeconds: 3 });
    await permit.refresh();
  });

  it('Redis 异常时 fail closed', async () => {
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(acquireVoiceStreamPermit('00000000-0000-4000-8000-000000000001'))
      .rejects.toBeInstanceOf(VoiceStreamProtectionUnavailableError);
  });
});
