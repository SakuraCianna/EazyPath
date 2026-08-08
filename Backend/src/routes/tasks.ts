import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { agentTasks, db } from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { enqueueAgentTask } from '../queue/task-queue.js';
import { appendTaskEvent, createTask, getTaskEvents, getTaskForInstallation, listTasks } from '../repositories/taskRepository.js';
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
      await db.update(agentTasks).set({ status: 'failed', failureCode: 'QUEUE_UNAVAILABLE', failureMessage: '任务队列暂时不可用', updatedAt: new Date() }).where(eq(agentTasks.id, result.task.id));
      await appendTaskEvent(result.task.id, 'task.failed', { code: 'QUEUE_UNAVAILABLE', retryable: true });
      return fail(c, 503, 'QUEUE_UNAVAILABLE', '任务已保存，但队列暂时不可用，可稍后重试', { retryable: true, retry_after_ms: 2_000 });
    }
  }
  return ok(c, { task_id: result.task.id, status: result.task.status, created: result.created }, result.created ? '任务已入队' : '返回幂等任务', 202);
});

tasksRouter.get('/:taskId/events', async (c) => {
  const task = await getTaskForInstallation(c.req.param('taskId'), c.get('installationId'));
  if (!task) return fail(c, 404, 'TASK_NOT_FOUND', '任务不存在');
  const headerCursor = Number(c.req.header('last-event-id') ?? 0);
  const queryCursor = Number(c.req.query('after') ?? 0);
  let cursor = Math.max(Number.isFinite(headerCursor) ? headerCursor : 0, Number.isFinite(queryCursor) ? queryCursor : 0);
  return streamSSE(c, async (stream) => {
    let idleCycles = 0;
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
      const [latest] = await db.select({ status: agentTasks.status }).from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
      if (idleCycles >= 2 && ['completed', 'failed', 'cancelled'].includes(latest?.status ?? '')) break;
      if (idleCycles > 0 && idleCycles % 15 === 0) await stream.writeSSE({ event: 'heartbeat', data: '{}' });
      await stream.sleep(1_000);
    }
  });
});

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
  if (!['needs_input', 'failed'].includes(task.status)) return fail(c, 409, 'TASK_STATE_CONFLICT', '当前任务状态不接受补充信息');
  const [queued] = await db.update(agentTasks).set({ originalContent: `${task.originalContent}\n补充信息: ${body.data.content}`, status: 'queued', updatedAt: new Date() }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, task.status))).returning();
  if (!queued) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务状态已变化，请刷新后重试');
  await appendTaskEvent(task.id, 'task.input_received', {});
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
  if (task.status !== 'failed') return fail(c, 409, 'TASK_STATE_CONFLICT', '只有失败任务可以重试');
  const [queued] = await db.update(agentTasks).set({ status: 'queued', failureCode: null, failureMessage: null, updatedAt: new Date() }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'failed'))).returning();
  if (!queued) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务已被其他请求处理，请刷新后重试');
  await appendTaskEvent(task.id, 'task.requeued', {});
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
  const [cancelled] = await db.update(agentTasks).set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, task.status))).returning({ id: agentTasks.id });
  if (!cancelled) return fail(c, 409, 'TASK_STATE_CONFLICT', '任务状态已变化，请刷新后重试');
  await appendTaskEvent(task.id, 'task.cancelled', {});
  return ok(c, { task_id: task.id, status: 'cancelled' });
});

async function markQueueFailure(taskId: string): Promise<void> {
  const [failed] = await db.update(agentTasks).set({
    status: 'failed',
    failureCode: 'QUEUE_UNAVAILABLE',
    failureMessage: '任务队列暂时不可用',
    updatedAt: new Date(),
  }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'queued'))).returning({ id: agentTasks.id });
  if (failed) await appendTaskEvent(taskId, 'task.failed', { code: 'QUEUE_UNAVAILABLE', retryable: true });
}
