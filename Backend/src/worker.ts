import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { Worker, type Job } from 'bullmq';
import { and, eq, or } from 'drizzle-orm';
import { getEnv, parseKeyring } from './config/env.js';
import { canRecoverRunningAgentTask } from './domain/agent-task-recovery.js';
import {
  agentSubtasks,
  agentTasks,
  db,
  serviceCards,
  taskEvents,
  verificationRecords,
} from './db/index.js';
import { hmacSha256 } from './lib/crypto.js';
import { redisConnectionOptions } from './queue/connection.js';
import { TASK_QUEUE_NAME, type TaskJobData } from './queue/task-queue.js';
import { searchAmapPlaces, type AmapPlace } from './services/amap.js';
import { AgentPlanningError, parseTravelIntent, type ParsedIntent } from './services/dashscope.js';
import { resolvePublicActions } from './services/deeplink.js';
import { verifyAccessibilityImage, VisionVerificationError } from './services/qwen-vl.js';
import { cleanupExpiredMedia, expireEvidenceAndCreateReviews } from './services/maintenance.js';

const env = getEnv();

const worker = new Worker<TaskJobData>(TASK_QUEUE_NAME, processJob, {
  connection: redisConnectionOptions(true),
  prefix: 'eazypath',
  concurrency: env.WORKER_CONCURRENCY,
});

worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ level: 'error', event: 'queue.job_failed', jobId: job?.id, message: error.message }));
});

async function processJob(job: Job<TaskJobData>): Promise<void> {
  switch (job.data.kind) {
    case 'agent.plan':
      await processAgentTask(job.data.taskId, job);
      return;
    case 'vision.verify':
      await processVisionVerification(job.data.verificationId, job.data.temporaryFilePath, job);
      return;
    case 'media.cleanup':
      await cleanupExpiredMedia();
      return;
    case 'evidence.expire':
      await expireEvidenceAndCreateReviews();
      return;
  }
}

async function processAgentTask(taskId: string, job: Job<TaskJobData>): Promise<void> {
  const canRecoverRunningTask = canRecoverRunningAgentTask(job);
  const claimToken = randomUUID();
  const task = await db.transaction(async (tx) => {
    const [running] = await tx.update(agentTasks).set({ status: 'running', runClaimToken: claimToken, failureCode: null, failureMessage: null, updatedAt: new Date() }).where(and(
      eq(agentTasks.id, taskId),
      canRecoverRunningTask
        ? or(eq(agentTasks.status, 'queued'), eq(agentTasks.status, 'running'))
        : eq(agentTasks.status, 'queued'),
    )).returning();
    if (!running) return null;
    await tx.insert(taskEvents).values({ taskId, eventType: 'task.running', eventData: { progress: 5 } });
    return running;
  });
  if (!task) return;
  await job.updateProgress(5);

  try {
    const intent = await parseTravelIntent(task.originalContent, task.profileSnapshot, task.clientTimezone);
    if (await isTaskCancelled(taskId)) return;
    const intentRecorded = await db.transaction(async (tx) => {
      const [updated] = await tx.update(agentTasks).set({ parsedIntent: intent, updatedAt: new Date() }).where(and(
        eq(agentTasks.id, taskId),
        eq(agentTasks.status, 'running'),
        eq(agentTasks.runClaimToken, claimToken),
      )).returning({ id: agentTasks.id });
      if (!updated) return false;
      await tx.insert(taskEvents).values({
        taskId,
        eventType: 'intent.parsed',
        eventData: { title: intent.title, destination: intent.destination, progress: 25 },
      });
      return true;
    });
    if (!intentRecorded) return;
    await job.updateProgress(25);

    const subtaskRows = await db.transaction(async (tx) => {
      const [claimedTask] = await lockClaimedAgentTask(tx, taskId, claimToken);
      if (!claimedTask) return null;
      await tx.delete(agentSubtasks).where(eq(agentSubtasks.taskId, taskId));
      return tx.insert(agentSubtasks).values(intent.tasks.map((item) => ({
        taskId,
        externalKey: item.id,
        category: item.category,
        title: item.title,
        dependsOn: item.dependsOn,
        params: item.params,
        status: 'running',
      }))).returning();
    });
    if (!subtaskRows) return;

    const cardsReset = await db.transaction(async (tx) => {
      const [claimedTask] = await lockClaimedAgentTask(tx, taskId, claimToken);
      if (!claimedTask) return false;
      await tx.delete(serviceCards).where(eq(serviceCards.taskId, taskId));
      return true;
    });
    if (!cardsReset) return;
    const cards = await buildServiceCards(taskId, intent, subtaskRows.map((row) => ({ id: row.id, key: row.externalKey, category: row.category })));
    if (await isTaskCancelled(taskId)) return;
    for (const card of cards) {
      const cardWritten = await db.transaction(async (tx) => {
        const [activeTask] = await lockClaimedAgentTask(tx, taskId, claimToken);
        if (!activeTask) return false;
        const [created] = await tx.insert(serviceCards).values(card).returning();
        if (created) {
          await tx.insert(taskEvents).values({ taskId, eventType: 'card.upserted', eventData: { card: created, progress: 75 } });
        }
        return true;
      });
      if (!cardWritten) return;
    }
    const completed = await db.transaction(async (tx) => {
      const [updated] = await tx.update(agentTasks).set({ status: 'completed', runClaimToken: null, completedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(agentTasks.id, taskId),
        eq(agentTasks.status, 'running'),
        eq(agentTasks.runClaimToken, claimToken),
      )).returning({ id: agentTasks.id });
      if (!updated) return null;
      await tx.update(agentSubtasks).set({ status: 'completed', updatedAt: new Date() }).where(eq(agentSubtasks.taskId, taskId));
      await tx.insert(taskEvents).values({ taskId, eventType: 'task.completed', eventData: { progress: 100, card_count: cards.length } });
      return updated;
    });
    if (!completed) return;
    await job.updateProgress(100);
  } catch (error) {
    const known = error instanceof AgentPlanningError;
    const failureCode = known ? error.code : 'TASK_PROCESSING_FAILED';
    const message = known ? error.message : '任务处理失败，请稍后重试';
    const retryable = known ? error.retryable : true;
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const nextStatus = retryable && !finalAttempt ? 'queued' : 'failed';
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(agentTasks).set({ status: nextStatus, runClaimToken: null, failureCode, failureMessage: message, updatedAt: new Date() }).where(and(
        eq(agentTasks.id, taskId),
        eq(agentTasks.status, 'running'),
        eq(agentTasks.runClaimToken, claimToken),
      )).returning({ id: agentTasks.id });
      if (updated) {
        await tx.insert(taskEvents).values({
          taskId,
          eventType: finalAttempt ? 'task.failed' : 'task.retrying',
          eventData: { code: failureCode, message, retryable, attempt: job.attemptsMade + 1 },
        });
      }
    });
    throw error;
  }
}

type AgentTaskTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function lockClaimedAgentTask(tx: AgentTaskTransaction, taskId: string, claimToken: string) {
  return tx.select({ id: agentTasks.id }).from(agentTasks).where(and(
    eq(agentTasks.id, taskId),
    eq(agentTasks.status, 'running'),
    eq(agentTasks.runClaimToken, claimToken),
  )).for('update').limit(1);
}

async function isTaskCancelled(taskId: string): Promise<boolean> {
  const [task] = await db.select({ status: agentTasks.status }).from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  return task?.status === 'cancelled';
}

async function buildServiceCards(
  taskId: string,
  intent: ParsedIntent,
  subtasks: Array<{ id: string; key: string; category: string }>,
): Promise<Array<typeof serviceCards.$inferInsert>> {
  const cards: Array<typeof serviceCards.$inferInsert> = [];
  const findSubtask = (category: string) => subtasks.find((item) => item.category === category)?.id;
  const categories = new Set(intent.tasks.map((task) => task.category));

  if (categories.has('rail')) {
    cards.push({
      taskId,
      subtaskId: findSubtask('rail'),
      category: 'rail',
      title: '铁路重点旅客服务准备',
      status: 'action_required',
      resultSnapshot: { destination: intent.destination, booking_completed: false },
      evidenceSummary: { source: '12306_public_rules', accessibility_status: 'requires_manual_application' },
      riskLevel: 'unknown',
      riskMessage: 'EazyPath 不代办车票或重点旅客预约，请在 12306 核对当前规则并人工提交。',
      actions: resolvePublicActions('railway12306', { destinationName: intent.destination, date: intent.startDate }),
    });
  }

  const hotelPlaces = categories.has('hotel')
    ? await searchAmapPlaces(`${intent.destination} 酒店`, '江西省', '100000')
    : [];
  addPlaceCards(cards, taskId, findSubtask('hotel'), 'hotel', hotelPlaces.slice(0, 3), 'ctrip');

  const diningPlaces = categories.has('dining')
    ? await searchAmapPlaces(`${intent.destination} 餐饮`, '江西省', '050000')
    : [];
  addPlaceCards(cards, taskId, findSubtask('dining'), 'dining', diningPlaces.slice(0, 3), 'meituan');

  if (categories.has('ride')) {
    const destination = hotelPlaces[0] ?? diningPlaces[0];
    cards.push({
      taskId,
      subtaskId: findSubtask('ride'),
      category: 'ride',
      title: destination ? `前往 ${destination.name} 的打车沟通卡` : '打车接驳沟通卡',
      status: 'action_required',
      resultSnapshot: { destination: destination?.name ?? intent.destination, booking_completed: false },
      evidenceSummary: { source: 'user_input', vehicle_accessibility: 'unknown' },
      riskLevel: 'unknown',
      riskMessage: '当前没有已授权的滴滴代叫车接口，车型和轮椅装载空间需与司机人工确认。',
      actions: resolvePublicActions('didi', { destinationName: destination?.name ?? intent.destination }),
    });
  }

  if (categories.has('route')) {
    const destination = hotelPlaces[0] ?? diningPlaces[0];
    cards.push({
      taskId,
      subtaskId: findSubtask('route'),
      category: 'route',
      title: destination ? `前往 ${destination.name} 的基础路线` : `前往 ${intent.destination} 的基础路线`,
      status: destination ? 'warning' : 'unavailable',
      resultSnapshot: destination ?? { destination: intent.destination },
      evidenceSummary: { source: destination ? 'amap' : 'none', wheelchair_route_mode: false, segment_evidence: 'unknown' },
      riskLevel: 'unknown',
      riskMessage: '高德没有轮椅路线模式。此入口仅打开普通步行路线，未覆盖路段必须现场复核。',
      actions: resolvePublicActions('amap', {
        destinationName: destination?.name ?? intent.destination,
        longitude: destination?.longitude,
        latitude: destination?.latitude,
      }),
    });
  }
  return cards;
}

function addPlaceCards(
  cards: Array<typeof serviceCards.$inferInsert>,
  taskId: string,
  subtaskId: string | undefined,
  category: 'hotel' | 'dining',
  places: AmapPlace[],
  platform: 'ctrip' | 'meituan',
): void {
  if (places.length === 0) {
    cards.push({
      taskId,
      subtaskId,
      category,
      title: category === 'hotel' ? '未找到可核验的酒店候选' : '未找到可核验的餐饮候选',
      status: 'unavailable',
      resultSnapshot: { candidates: [] },
      evidenceSummary: { source: 'amap', accessibility_status: 'unknown' },
      riskLevel: 'unknown',
      riskMessage: '地点服务没有返回候选，系统不会使用演示数据填充。',
      actions: [],
    });
    return;
  }
  for (const place of places) {
    cards.push({
      taskId,
      subtaskId,
      category,
      title: place.name,
      status: 'needs_verification',
      resultSnapshot: place,
      evidenceSummary: { source: 'amap', accessibility_status: 'unknown', verified_features: [] },
      riskLevel: 'unknown',
      riskMessage: '高德 POI 不代表已满足无障碍条件；当前缺少经审核的入口、门宽和卫生间证据。',
      actions: resolvePublicActions(platform, { destinationName: place.name }),
    });
  }
}

async function processVisionVerification(verificationId: string, temporaryFilePath: string, job: Job<TaskJobData>): Promise<void> {
  const [record] = await db.select().from(verificationRecords).where(eq(verificationRecords.id, verificationId)).limit(1);
  if (!record || record.status === 'completed') return;
  await db.update(verificationRecords).set({ status: 'running', updatedAt: new Date() }).where(eq(verificationRecords.id, verificationId));
  let completed = false;
  try {
    const file = await readFile(temporaryFilePath);
    const mimeType = detectImageMime(file);
    const result = await verifyAccessibilityImage(`data:${mimeType};base64,${file.toString('base64')}`, record.scene);
    const keyring = parseKeyring(env.MEDIA_FINGERPRINT_KEYRING);
    const fingerprintKey = keyring.get(env.MEDIA_FINGERPRINT_KEY_CURRENT_VERSION);
    if (!fingerprintKey) throw new Error('MEDIA_FINGERPRINT_KEY_MISSING');
    await db.update(verificationRecords).set({
      status: 'completed',
      resultJson: result,
      confidence: String(result.overall_confidence),
      riskLevel: result.risk_level,
      imageFingerprintHmac: hmacSha256(file, fingerprintKey),
      fingerprintKeyVersion: env.MEDIA_FINGERPRINT_KEY_CURRENT_VERSION,
      fingerprintExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    }).where(eq(verificationRecords.id, verificationId));
    completed = true;
  } catch (error) {
    const code = error instanceof VisionVerificationError ? error.code : 'VISION_PROCESSING_FAILED';
    await db.update(verificationRecords).set({ status: 'failed', failureCode: code, updatedAt: new Date() }).where(eq(verificationRecords.id, verificationId));
    throw error;
  } finally {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (completed || finalAttempt) {
      await rm(temporaryFilePath, { force: true });
      await db.update(verificationRecords).set({ temporaryMediaDeletedAt: new Date(), originalMediaStored: false, updatedAt: new Date() }).where(eq(verificationRecords.id, verificationId));
    }
  }
}

function detectImageMime(file: Buffer): string {
  if (file.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (file.subarray(0, 4).toString('ascii') === 'RIFF' && file.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('UNSUPPORTED_IMAGE_TYPE');
}

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ level: 'info', event: 'worker.shutdown', signal }));
  await worker.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
