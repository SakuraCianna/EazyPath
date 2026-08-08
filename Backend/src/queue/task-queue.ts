import { Queue } from 'bullmq';
import { redisConnectionOptions } from './connection.js';

export const TASK_QUEUE_NAME = 'eazypath-agent-tasks';

export type TaskJobData =
  | { kind: 'agent.plan'; taskId: string }
  | { kind: 'vision.verify'; verificationId: string; temporaryFilePath: string }
  | { kind: 'media.cleanup' }
  | { kind: 'evidence.expire' };

export const taskQueue = new Queue<TaskJobData>(TASK_QUEUE_NAME, {
  connection: redisConnectionOptions(false),
  prefix: 'eazypath',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { age: 86_400, count: 2_000 },
    removeOnFail: { age: 7 * 86_400, count: 5_000 },
  },
});

export async function enqueueAgentTask(taskId: string, attemptKey = 'initial'): Promise<void> {
  await taskQueue.add(
    'agent.plan',
    { kind: 'agent.plan', taskId },
    { jobId: `agent-${taskId}-${attemptKey}` },
  );
}

export async function enqueueVisionVerification(
  verificationId: string,
  temporaryFilePath: string,
): Promise<void> {
  await taskQueue.add(
    'vision.verify',
    { kind: 'vision.verify', verificationId, temporaryFilePath },
    { jobId: `vision-${verificationId}` },
  );
}

export async function registerMaintenanceSchedules(): Promise<void> {
  await taskQueue.upsertJobScheduler(
    'media-cleanup-every-minute',
    { every: 60_000 },
    { name: 'media.cleanup', data: { kind: 'media.cleanup' } },
  );
  await taskQueue.upsertJobScheduler(
    'evidence-expiry-daily',
    { pattern: '15 3 * * *' },
    { name: 'evidence.expire', data: { kind: 'evidence.expire' } },
  );
}
