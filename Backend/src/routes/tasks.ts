import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { decideTaskEventResume, parseTaskEventCursor } from '../domain/task-event-stream.js';
import { getEnv } from '../config/env.js';
import { agentTasks, db, taskEvents } from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { enqueueAgentTask } from '../queue/task-queue.js';
import { createTask, getLatestTaskEventId, getTaskEventCursor, getTaskEvents, getTaskForInstallation, getTaskIdentityForInstallation, listTasks } from '../repositories/taskRepository.js';
import { hasActiveAiConsent } from '../services/ai-consent.js';
import { acquireTaskEventStreamPermit, TaskEventStreamProtectionUnavailableError } from '../services/task-event-stream-guard.js';
import type { AppBindings } from '../types.js';

const createTaskSchema = z.object({
  input_type: z.enum(['text', 'voice_text']).default('text'),
  content: z.string().trim().min(2).max(10_000),
  profile_version: z.number().int().positive(),
  client_timezone: z.string().min(1).max(64).default('Asia/Shanghai'),
});

export const tasksRouter = new Hono<AppBindings>();
tasksRouter.use('*', requireUser);

tasksRouter.get('/', async (c) => ok(c, await listTasks(c.get('installationId'))));

tasksRouter.post('/', async (c) => {
  const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'INVALID_INPUT', '出行需求参数无效');
  if (!await hasActiveAiConsent(c.get('installationId'), 'agent')) {
    return fail(c, 403, 'AI_CONSENT_REQUIRED', '请先阅读并同意智能文本规划说明，或改用手动搜索', {
      retryable: false,
      details: { capability: 'agent' },
    });
  }
  const idempotencyKey = c.req.header('idempotency-key');
  const result = await createTask({
    installationId: c.get('installationId'),
    inputType: parsed.data.input_type,
    content: parsed.data.content,
    profileVersion: parsed.data.profile_version,
    clientTimezone: parsed.data.client_timezone,
    idempotencyKey,
  });
  if (!result) return fail(c, 409, 'PROFILE_VERSION_CONFLICT', '偏好版本已更新，请刷新后重试');
  if (result.created) {
    try {
      await enqueueAgentTask(result.task.id);
    } catch {
      await markQueueFailure(result.task.id);
      return fail(c, 503, 'QUEUE_UNAVAILABLE', '任务已保存，但队列暂时不可用，可稍后重试', { retryable: true, retry_after_ms: 2_000 });
    }
  }
  return ok(c, { task_id: result.task.id, status: result.task.status, created: result.created }, result.created ? '任务已入队' : '返回幂等任务', 202);
});

tasksRouter.get('/:taskId/events', async (c) => {
  const taskId = z.uuid().safeParse(c.req.param('taskId'));
  if (!taskId.success) return fail(c, 422, 'INVALID_TASK_ID', '任务 ID 无效');
  const cursorInput = parseTaskEventCursor(c.req.header('last-event-id'), c.req.query('after'));
  if (!cursorInput.ok) return fail(c, 422, 'INVALID_EVENT_CURSOR', '事件游标无效');
  let permit;
  try {
    permit = await acquireTaskEventStreamPermit(c.get('installationId'));
  } catch (error) {
    if (error instanceof TaskEventStreamProtectionUnavailableError) {
      return fail(c, 503, 'EVENT_STREAM_PROTECTION_UNAVAILABLE', '任务事件流保护服务暂时不可用', { retryable: true });
    }
    throw error;
  }
  if (!permit.allowed) {
    c.header('Retry-After', String(permit.retryAfterSeconds));
    return fail(c, 429, 'EVENT_STREAM_LIMITED', '任务事件连接过于频繁，请稍后重试', {
      retryable: true,
      retry_after_ms: permit.retryAfterSeconds * 1_000,
    });
  }
  let task;
  try {
    task = await getTaskIdentityForInstallation(taskId.data, c.get('installationId'));
  } catch (error) {
    await permit.release().catch(() => undefined);
    throw error;
  }
  if (!task) {
    await permit.release().catch(() => undefined);
    return fail(c, 404, 'TASK_NOT_FOUND', '任务不存在');
  }
  let cursorEvent;
  let latestEventId;
  try {
    [cursorEvent, latestEventId] = await Promise.all([
      cursorInput.cursor === 0 ? Promise.resolve(null) : getTaskEventCursor(task.id, cursorInput.cursor),
      getLatestTaskEventId(task.id),
    ]);
  } catch (error) {
    await permit.release().catch(() => undefined);
    throw error;
  }
  const resume = decideTaskEventResume({
    cursor: cursorInput.cursor,
    cursorOccurredAt: cursorEvent?.occurredAt ?? null,
    latestEventId,
    now: new Date(),
    resumeWindowSeconds: getEnv().SSE_RESUME_WINDOW_SECONDS,
  });
  let cursor = resume.cursor;
  c.header('Cache-Control', 'no-store');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    try {
      if (resume.kind === 'reset') {
        await writeTaskStreamReset(stream, task.id, cursor, resume.reason);
      }
      let idleCycles = 0;
      let leaseCycles = 0;
      while (!stream.aborted) {
        const events = await getTaskEvents(task.id, cursor);
        for (const event of events) {
          cursor = event.id;
          await stream.writeSSE({
            id: String(event.id),
            event: event.eventType,
            data: JSON.stringify({
              event_id: event.id,
              task_id: event.taskId,
              type: event.eventType,
              schema_version: event.schemaVersion,
              occurred_at: event.occurredAt.toISOString(),
              data: event.eventData,
            }),
          });
        }
        idleCycles = events.length === 0 ? idleCycles + 1 : 0;
        leaseCycles += 1;
        if (leaseCycles >= 30) {
          await permit.refresh();
          leaseCycles = 0;
        }
        if (idleCycles >= 5 && idleCycles % 5 === 0) {
          const [latest] = await db.select({ status: agentTasks.status }).from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
          if (['completed', 'failed', 'cancelled'].includes(latest?.status ?? '')) {
            // A terminal snapshot can exist even if a process stopped between the state update and event insert.
            await writeTaskStreamReset(stream, task.id, cursor, 'terminal_snapshot');
            break;
          }
        }
        if (idleCycles > 0 && idleCycles % 15 === 0) await stream.writeSSE({ event: 'heartbeat', data: '{}' });
        await stream.sleep(1_000);
      }
    } finally {
      await permit.release().catch(() => undefined);
    }
  });
});

async function writeTaskStreamReset(
  stream: { writeSSE: (input: { id?: string; event: string; data: string }) => Promise<void> },
  taskId: string,
  cursor: number,
  reason: 'cursor_not_found' | 'resume_window_expired' | 'terminal_snapshot',
): Promise<void> {
  await stream.writeSSE({
    ...(cursor > 0 ? { id: String(cursor) } : {}),
    event: 'stream.reset',
    data: JSON.stringify({
      event_id: cursor,
      task_id: taskId,
      type: 'stream.reset',
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      data: { reason },
    }),
  });
}

tasksRouter.get('/:taskId', async (c) => {
  const task = await getTaskForInstallation(c.req.param('taskId'), c.get('installationId'));
  if (!task) return fail(c, 404, 'TASK_NOT_FOUND', '任务不存在');
  return ok(c, task);
});

tasksRouter.post('/:taskId/input', async (c) => {
  const body = z.object({ content: z.string().trim().min(1).max(5000) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return fail(c, 422, 'INVALID_INPUT', '补充信息无效');
  const task = await getTaskForInstallation(c.req.param('taskId'), c.get('installationId'));
  if (!task) return fail(c, 404, 'TASK_NOT_FOUND', '任务不存在');
  if (!await hasActiveAiConsent(c.get('installationId'), 'agent')) {
    return fail(c, 403, 'AI_CONSENT_REQUIRED', '智能文本规划同意已撤回，补充内容不会发送给模型', {
      retryable: false,
      details: { capability: 'agent' },
    });
  }
  if (!['needs_input', 'failed'].includes(task.status)) return fail(c, 409, 'TASK_STATE_CONFLICT', '当前任务状态不接受补充信息');
  const queued = await db.transaction(async (tx) => {
    const [updated] = await tx.update(agentTasks).set({ originalContent: `${task.originalContent}\n补充信息: ${body.data.content}`, status: 'queued', runClaimToken: null, updatedAt: new Date() }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, task.status))).returning();
    if (!updated) return null;
    await tx.insert(taskEvents).values({ taskId: task.id, eventType: 'task.input_received', eventData: {} });
    return updated;
  });
  if (!queued) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务状态已变化，请刷新后重试');
  try {
    await enqueueAgentTask(task.id, `input-${queued.updatedAt.getTime()}`);
  } catch {
    await markQueueFailure(task.id);
    return fail(c, 503, 'QUEUE_UNAVAILABLE', '补充信息已保存，但队列暂时不可用，可稍后重试', { retryable: true, retry_after_ms: 2_000 });
  }
  return ok(c, { task_id: task.id, status: 'queued' }, '补充信息已入队', 202);
});

tasksRouter.post('/:taskId/retry', async (c) => {
  const task = await getTaskForInstallation(c.req.param('taskId'), c.get('installationId'));
  if (!task) return fail(c, 404, 'TASK_NOT_FOUND', '任务不存在');
  if (!await hasActiveAiConsent(c.get('installationId'), 'agent')) {
    return fail(c, 403, 'AI_CONSENT_REQUIRED', '智能文本规划同意已撤回，任务不会重新发送给模型', {
      retryable: false,
      details: { capability: 'agent' },
    });
  }
  if (task.status !== 'failed') return fail(c, 409, 'TASK_STATE_CONFLICT', '只有失败任务可以重试');
  const queued = await db.transaction(async (tx) => {
    const [updated] = await tx.update(agentTasks).set({ status: 'queued', runClaimToken: null, failureCode: null, failureMessage: null, updatedAt: new Date() }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'failed'))).returning();
    if (!updated) return null;
    await tx.insert(taskEvents).values({ taskId: task.id, eventType: 'task.requeued', eventData: {} });
    return updated;
  });
  if (!queued) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务已被其他请求处理，请刷新后重试');
  try {
    await enqueueAgentTask(task.id, `retry-${queued.updatedAt.getTime()}`);
  } catch {
    await markQueueFailure(task.id);
    return fail(c, 503, 'QUEUE_UNAVAILABLE', '任务已保存，但队列暂时不可用，可稍后重试', { retryable: true, retry_after_ms: 2_000 });
  }
  return ok(c, { task_id: task.id, status: 'queued' }, '任务已重新入队', 202);
});

tasksRouter.post('/:taskId/cancel', async (c) => {
  const task = await getTaskForInstallation(c.req.param('taskId'), c.get('installationId'));
  if (!task) return fail(c, 404, 'TASK_NOT_FOUND', '任务不存在');
  if (['completed', 'cancelled'].includes(task.status)) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务已结束');
  const cancelled = await db.transaction(async (tx) => {
    const [updated] = await tx.update(agentTasks).set({ status: 'cancelled', runClaimToken: null, cancelledAt: new Date(), updatedAt: new Date() }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, task.status))).returning({ id: agentTasks.id });
    if (!updated) return null;
    await tx.insert(taskEvents).values({ taskId: task.id, eventType: 'task.cancelled', eventData: {} });
    return updated;
  });
  if (!cancelled) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务状态已变化，请刷新后重试');
  return ok(c, { task_id: task.id, status: 'cancelled' });
});

async function markQueueFailure(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [failed] = await tx.update(agentTasks).set({
      status: 'failed',
      runClaimToken: null,
      failureCode: 'QUEUE_UNAVAILABLE',
      failureMessage: '任务队列暂时不可用',
      updatedAt: new Date(),
    }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'queued'))).returning({ id: agentTasks.id });
    if (failed) {
      await tx.insert(taskEvents).values({
        taskId,
        eventType: 'task.failed',
        eventData: { code: 'QUEUE_UNAVAILABLE', retryable: true },
      });
    }
  });
}
