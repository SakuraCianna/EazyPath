import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  eval: vi.fn(),
  quit: vi.fn(async () => 'OK'),
  disconnect: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: class {
    constructor(..._arguments: unknown[]) {}
    eval(...arguments_: unknown[]) { return redis.eval(...arguments_); }
    on() { return this; }
    quit() { return redis.quit(); }
    disconnect() { return redis.disconnect(); }
  },
}));
vi.mock('../config/env.js', () => ({ getEnv: () => ({ REDIS_URL: 'redis://localhost:6379' }) }));

import {
  acquireTaskEventStreamPermit,
  closeTaskEventStreamGuard,
  TaskEventStreamProtectionUnavailableError,
} from './task-event-stream-guard.js';

describe('任务事件流 Redis 租约', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => closeTaskEventStreamGuard());

  it('允许连接后可续租并从安装账户和全局集合释放', async () => {
    redis.eval.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce(1).mockResolvedValueOnce(1);

    const permit = await acquireTaskEventStreamPermit('00000000-0000-4000-8000-000000000001');
    await permit.refresh();
    await permit.release();

    expect(permit.allowed).toBe(true);
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it('连接频率或并发超限时返回有界重试时间且不创建租约操作', async () => {
    redis.eval.mockResolvedValueOnce([0, 2_500]);

    const permit = await acquireTaskEventStreamPermit('00000000-0000-4000-8000-000000000001');

    expect(permit.allowed).toBe(false);
    expect(permit.retryAfterSeconds).toBe(3);
    await permit.refresh();
    await permit.release();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('Redis 异常时停止开流而不是绕过保护', async () => {
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(acquireTaskEventStreamPermit('00000000-0000-4000-8000-000000000001'))
      .rejects.toBeInstanceOf(TaskEventStreamProtectionUnavailableError);
  });
});
