import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  installationId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
}));
const repository = vi.hoisted(() => ({
  appendTaskEvent: vi.fn(),
  createTask: vi.fn(),
  getLatestTaskEventId: vi.fn(),
  getTaskEventCursor: vi.fn(),
  getTaskEvents: vi.fn(),
  getTaskForInstallation: vi.fn(),
  getTaskIdentityForInstallation: vi.fn(),
  listTasks: vi.fn(),
}));
const streaming = vi.hoisted(() => {
  const writeSSE = vi.fn(async (_input: unknown) => undefined);
  const stream = {
    aborted: true,
    writeSSE,
    sleep: vi.fn(async (_milliseconds: number) => undefined),
  };
  return {
    stream,
    writeSSE,
    streamSSE: vi.fn(async (
      c: { json: (body: unknown) => Response },
      handler: (value: typeof stream) => Promise<void>,
    ) => {
      await handler(stream);
      return c.json({ streamed: true });
    }),
  };
});
const database = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => [{ status: 'completed' }]) })),
    })),
  })),
  update: vi.fn(),
}));
const eventStreamGuard = vi.hoisted(() => ({
  permit: {
    allowed: true,
    retryAfterSeconds: 0,
    refresh: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  },
  acquireTaskEventStreamPermit: vi.fn(),
  ProtectionUnavailableError: class extends Error {},
}));

vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('hono/streaming', () => ({ streamSSE: streaming.streamSSE }));
vi.mock('../config/env.js', () => ({ getEnv: () => ({ SSE_RESUME_WINDOW_SECONDS: 86_400 }) }));
vi.mock('../db/index.js', () => ({
  agentTasks: { id: 'id', status: 'status' },
  db: database,
}));
vi.mock('../middleware/auth.js', () => ({
  requireUser: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('installationId', fixtures.installationId);
    await next();
  },
}));
vi.mock('../queue/task-queue.js', () => ({ enqueueAgentTask: vi.fn() }));
vi.mock('../repositories/taskRepository.js', () => repository);
vi.mock('../services/task-event-stream-guard.js', () => ({
  acquireTaskEventStreamPermit: eventStreamGuard.acquireTaskEventStreamPermit,
  TaskEventStreamProtectionUnavailableError: eventStreamGuard.ProtectionUnavailableError,
}));

import { tasksRouter } from './tasks.js';
import type { AppBindings } from '../types.js';

function testApp() {
  const app = new Hono<AppBindings>();
  app.route('/tasks', tasksRouter);
  return app;
}

describe('任务 SSE 输入边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T01:00:00.000Z'));
    streaming.stream.aborted = true;
    eventStreamGuard.acquireTaskEventStreamPermit.mockResolvedValue(eventStreamGuard.permit);
  });
  afterEach(() => vi.useRealTimers());

  it('在查询数据库前拒绝非法任务 ID', async () => {
    const response = await testApp().request('/tasks/not-a-uuid/events');
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('INVALID_TASK_ID');
    expect(repository.getTaskIdentityForInstallation).not.toHaveBeenCalled();
  });

  it('在查询数据库前拒绝负数和科学计数法游标', async () => {
    for (const cursor of ['-1', '1e3']) {
      const response = await testApp().request(`/tasks/${fixtures.taskId}/events?after=${cursor}`);
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('INVALID_EVENT_CURSOR');
    }
    expect(repository.getTaskIdentityForInstallation).not.toHaveBeenCalled();
  });

  it('安装账户连接超限时返回 Retry-After 且不查询任务', async () => {
    eventStreamGuard.acquireTaskEventStreamPermit.mockResolvedValue({
      ...eventStreamGuard.permit,
      allowed: false,
      retryAfterSeconds: 3,
    });

    const response = await testApp().request(`/tasks/${fixtures.taskId}/events`);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(repository.getTaskIdentityForInstallation).not.toHaveBeenCalled();
  });

  it('Redis 保护不可用时停止开流', async () => {
    eventStreamGuard.acquireTaskEventStreamPermit.mockRejectedValue(new eventStreamGuard.ProtectionUnavailableError());

    const response = await testApp().request(`/tasks/${fixtures.taskId}/events`);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('EVENT_STREAM_PROTECTION_UNAVAILABLE');
    expect(repository.getTaskIdentityForInstallation).not.toHaveBeenCalled();
  });

  it('过期游标先发 reset 并移动到当前任务最新事件', async () => {
    repository.getTaskIdentityForInstallation.mockResolvedValue({ id: fixtures.taskId });
    repository.getTaskEventCursor.mockResolvedValue({
      id: 8,
      occurredAt: new Date('2026-08-09T00:00:00.000Z'),
    });
    repository.getLatestTaskEventId.mockResolvedValue(12);

    const response = await testApp().request(`/tasks/${fixtures.taskId}/events?after=8`);

    expect(response.status).toBe(200);
    expect(streaming.writeSSE).toHaveBeenCalledWith(expect.objectContaining({
      id: '12',
      event: 'stream.reset',
    }));
    expect(eventStreamGuard.permit.release).toHaveBeenCalledTimes(1);
  });

  it('终态事件缺失时用 reset 触发客户端读取终态快照', async () => {
    repository.getTaskIdentityForInstallation.mockResolvedValue({ id: fixtures.taskId });
    repository.getTaskEventCursor.mockResolvedValue({
      id: 12,
      occurredAt: new Date('2026-08-11T00:59:00.000Z'),
    });
    repository.getLatestTaskEventId.mockResolvedValue(12);
    repository.getTaskEvents.mockResolvedValue([]);
    streaming.stream.aborted = false;

    const response = await testApp().request(`/tasks/${fixtures.taskId}/events?after=12`);

    expect(response.status).toBe(200);
    expect(streaming.writeSSE).toHaveBeenCalledWith(expect.objectContaining({
      id: '12',
      event: 'stream.reset',
      data: expect.stringContaining('terminal_snapshot'),
    }));
  });
});
