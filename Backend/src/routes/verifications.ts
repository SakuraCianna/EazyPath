import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { db, verificationRecords } from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { enqueueVisionVerification } from '../queue/task-queue.js';
import { removeTemporaryVerificationImage, saveTemporaryVerificationImage } from '../services/media-storage.js';
import { lockCanonicalPlace, resolveActivePlace } from '../services/place-resolution.js';
import type { AppBindings } from '../types.js';

export const verificationsRouter = new Hono<AppBindings>();
verificationsRouter.use('*', requireUser);

verificationsRouter.post('/images', async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  const image = body?.image;
  const scene = typeof body?.scene === 'string' ? body.scene : 'general_accessibility';
  const rawPlaceId = typeof body?.place_id === 'string' ? body.place_id : undefined;
  if (!(image instanceof File)) return fail(c, 422, 'INVALID_IMAGE', '请选择已在端侧完成脱敏预览的图片');
  if (rawPlaceId && !z.uuid().safeParse(rawPlaceId).success) return fail(c, 422, 'PLACE_ID_INVALID', '地点 ID 无效');
  const place = rawPlaceId ? await resolveActivePlace(rawPlaceId) : undefined;
  if (rawPlaceId && !place) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在或已停用');

  let temporaryFilePath: string;
  try {
    temporaryFilePath = await saveTemporaryVerificationImage(image);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID_IMAGE';
    return fail(c, code === 'IMAGE_SIZE_INVALID' ? 413 : 422, code, '图片格式或大小不符合要求');
  }

  let record: typeof verificationRecords.$inferSelect | undefined;
  try {
    record = await db.transaction(async (tx) => {
      const lockedPlace = place ? await lockCanonicalPlace(tx, place.id) : undefined;
      if (place && !lockedPlace) return undefined;
      return (await tx.insert(verificationRecords).values({
        installationId: c.get('installationId'),
        placeId: lockedPlace?.id,
        scene,
        modelName: getEnv().VISION_MODEL,
        promptVersion: 'accessibility-v1',
        originalMediaStored: false,
      }).returning())[0];
    });
  } catch (error) {
    await removeTemporaryVerificationImage(temporaryFilePath).catch(() => undefined);
    throw error;
  }
  if (!record) {
    await removeTemporaryVerificationImage(temporaryFilePath).catch(() => undefined);
    return fail(c, 409, 'PLACE_STATE_CHANGED', '地点状态刚刚发生变化，请刷新地点后重新验真');
  }
  try {
    await enqueueVisionVerification(record.id, temporaryFilePath);
  } catch {
    try {
      await db.update(verificationRecords).set({ status: 'failed', failureCode: 'QUEUE_UNAVAILABLE', updatedAt: new Date() }).where(eq(verificationRecords.id, record.id));
    } finally {
      await removeTemporaryVerificationImage(temporaryFilePath).catch(() => undefined);
    }
    return fail(c, 503, 'QUEUE_UNAVAILABLE', '验真任务队列暂时不可用', { retryable: true });
  }
  return ok(c, {
    verification_id: record.id,
    status: 'queued',
    privacy_notice: '图片仅用于本次 AI 验真，处理完成后立即删除；服务端不保存原图。',
  }, '验真任务已入队', 202);
});

verificationsRouter.get('/:id', async (c) => {
  const [record] = await db.select().from(verificationRecords).where(and(eq(verificationRecords.id, c.req.param('id')), eq(verificationRecords.installationId, c.get('installationId')))).limit(1);
  if (!record) return fail(c, 404, 'VERIFICATION_NOT_FOUND', '验真记录不存在');
  return ok(c, {
    id: record.id,
    status: record.status,
    scene: record.scene,
    result: record.resultJson,
    confidence: record.confidence,
    risk_level: record.riskLevel,
    failure_code: record.failureCode,
    original_media_stored: false,
    temporary_media_deleted_at: record.temporaryMediaDeletedAt,
    created_at: record.createdAt,
  });
});
