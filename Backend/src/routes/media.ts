import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import {
  db,
  evidenceMedia,
  mediaUploadParts,
  mediaUploadSessions,
} from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import {
  assembleEvidenceFile,
  MEDIA_MAX_PARTS,
  MEDIA_PART_BYTES,
  mediaDiskUsageBytes,
  removeEvidenceFile,
  removeUploadDirectory,
  writeUploadPart,
} from '../services/media-storage.js';
import type { AppBindings } from '../types.js';

const initializeSchema = z.object({
  file_name: z.string().min(1).max(255),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  total_bytes: z.number().int().positive(),
  total_parts: z.number().int().min(1).max(MEDIA_MAX_PARTS),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  redaction_confirmed: z.literal(true),
});

export const mediaRouter = new Hono<AppBindings>();
mediaRouter.use('*', requireUser);

mediaRouter.post('/uploads', async (c) => {
  const parsed = initializeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'MEDIA_UPLOAD_INVALID', '上传参数无效，必须先确认脱敏预览');
  const input = parsed.data;
  const env = getEnv();
  if (input.total_bytes > env.MEDIA_MAX_IMAGE_BYTES) return fail(c, 413, 'MEDIA_TOO_LARGE', '图片超过大小限制');
  if (input.total_parts !== Math.ceil(input.total_bytes / MEDIA_PART_BYTES)) return fail(c, 422, 'MEDIA_PART_COUNT_INVALID', '分片数量与文件大小不匹配');
  if (await mediaDiskUsageBytes() + input.total_bytes > env.MEDIA_QUOTA_BYTES) return fail(c, 503, 'MEDIA_QUOTA_EXCEEDED', '服务器媒体空间暂时不足', { retryable: true });

  const idempotencyKey = c.req.header('idempotency-key');
  if (idempotencyKey) {
    const [existing] = await db.select().from(mediaUploadSessions).where(and(eq(mediaUploadSessions.installationId, c.get('installationId')), eq(mediaUploadSessions.idempotencyKey, idempotencyKey), gt(mediaUploadSessions.expiresAt, new Date()))).limit(1);
    if (existing) return ok(c, uploadResponse(existing));
  }
  const [session] = await db.insert(mediaUploadSessions).values({
    installationId: c.get('installationId'),
    fileName: input.file_name,
    mimeType: input.mime_type,
    totalBytes: input.total_bytes,
    totalParts: input.total_parts,
    wholeSha256: input.sha256.toLowerCase(),
    redactionConfirmed: true,
    idempotencyKey,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).onConflictDoNothing().returning();
  if (!session && idempotencyKey) {
    const [concurrent] = await db.select().from(mediaUploadSessions).where(and(
      eq(mediaUploadSessions.installationId, c.get('installationId')),
      eq(mediaUploadSessions.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (concurrent) return ok(c, uploadResponse(concurrent));
  }
  if (!session) return fail(c, 500, 'MEDIA_UPLOAD_CREATE_FAILED', '无法创建上传会话', { retryable: true });
  return ok(c, uploadResponse(session), '上传会话已创建', 201);
});

mediaRouter.get('/uploads/:uploadId', async (c) => {
  const session = await ownedUpload(c.req.param('uploadId'), c.get('installationId'));
  if (!session) return fail(c, 404, 'MEDIA_UPLOAD_NOT_FOUND', '上传会话不存在');
  const parts = await db.select({ part_number: mediaUploadParts.partNumber, byte_size: mediaUploadParts.byteSize, sha256: mediaUploadParts.sha256 }).from(mediaUploadParts).where(eq(mediaUploadParts.uploadId, session.id)).orderBy(asc(mediaUploadParts.partNumber));
  return ok(c, { ...uploadResponse(session), received_parts: parts });
});

mediaRouter.put('/uploads/:uploadId/parts/:partNo', async (c) => {
  const session = await ownedUpload(c.req.param('uploadId'), c.get('installationId'));
  if (!session || session.status !== 'uploading' || session.expiresAt <= new Date()) return fail(c, 404, 'MEDIA_UPLOAD_NOT_FOUND', '上传会话不存在或已过期');
  const partNumber = Number(c.req.param('partNo'));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) return fail(c, 422, 'MEDIA_PART_NUMBER_INVALID', '分片编号无效');
  const bytes = Buffer.from(await c.req.arrayBuffer());
  const expectedLength = partNumber === session.totalParts ? session.totalBytes - MEDIA_PART_BYTES * (session.totalParts - 1) : MEDIA_PART_BYTES;
  if (bytes.length !== expectedLength) return fail(c, 422, 'MEDIA_PART_SIZE_INVALID', '分片大小与声明不一致');
  const declaredHash = c.req.header('x-part-sha256')?.toLowerCase();
  if (!declaredHash || sha256(bytes) !== declaredHash) return fail(c, 422, 'MEDIA_PART_HASH_MISMATCH', '分片校验失败');
  const stored = await writeUploadPart(session.id, partNumber, bytes);
  await db.insert(mediaUploadParts).values({ uploadId: session.id, partNumber, byteSize: bytes.length, sha256: stored.sha256, storagePath: stored.path }).onConflictDoUpdate({
    target: [mediaUploadParts.uploadId, mediaUploadParts.partNumber],
    set: { byteSize: bytes.length, sha256: stored.sha256, storagePath: stored.path },
  });
  return ok(c, { upload_id: session.id, part_number: partNumber, sha256: stored.sha256 });
});

mediaRouter.post('/uploads/:uploadId/complete', async (c) => {
  const session = await ownedUpload(c.req.param('uploadId'), c.get('installationId'));
  if (!session) return fail(c, 404, 'MEDIA_UPLOAD_NOT_FOUND', '上传会话不存在');
  if (session.status === 'completed' && session.completedMediaId) return ok(c, { media_id: session.completedMediaId, status: 'pending_link' });
  if (session.status !== 'uploading') return fail(c, 409, 'MEDIA_UPLOAD_BUSY', '上传会话正在完成处理中，请稍后查询');
  const parts = await db.select().from(mediaUploadParts).where(eq(mediaUploadParts.uploadId, session.id)).orderBy(asc(mediaUploadParts.partNumber));
  if (parts.length !== session.totalParts) return fail(c, 409, 'MEDIA_PARTS_INCOMPLETE', '仍有分片未上传');
  const [claimed] = await db.update(mediaUploadSessions).set({ status: 'assembling', updatedAt: new Date() }).where(and(
    eq(mediaUploadSessions.id, session.id),
    eq(mediaUploadSessions.status, 'uploading'),
  )).returning({ id: mediaUploadSessions.id });
  if (!claimed) {
    const latest = await ownedUpload(session.id, c.get('installationId'));
    if (latest?.status === 'completed' && latest.completedMediaId) return ok(c, { media_id: latest.completedMediaId, status: 'pending_link' });
    return fail(c, 409, 'MEDIA_UPLOAD_BUSY', '上传会话正在完成处理中，请稍后查询');
  }
  let stored: Awaited<ReturnType<typeof assembleEvidenceFile>> | undefined;
  try {
    const assembled = await assembleEvidenceFile(session.id, parts.map((part) => part.storagePath), session.wholeSha256);
    stored = assembled;
    const media = await db.transaction(async (tx) => {
      const [created] = await tx.insert(evidenceMedia).values({
        installationId: c.get('installationId'),
        ...assembled,
        redactionConfirmed: true,
        status: 'pending_link',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).returning();
      if (!created) throw new Error('MEDIA_RECORD_CREATE_FAILED');
      const [completed] = await tx.update(mediaUploadSessions).set({ status: 'completed', completedMediaId: created.id, updatedAt: new Date() }).where(and(
        eq(mediaUploadSessions.id, session.id),
        eq(mediaUploadSessions.status, 'assembling'),
      )).returning({ id: mediaUploadSessions.id });
      if (!completed) throw new Error('MEDIA_UPLOAD_STATE_CONFLICT');
      return created;
    });
    await removeUploadDirectory(session.id).catch((error: unknown) => {
      console.error(JSON.stringify({ level: 'error', event: 'media.upload_directory_cleanup_failed', uploadId: session.id, message: error instanceof Error ? error.message : 'unknown' }));
    });
    return ok(c, { media_id: media.id, status: media.status, link_before: media.expiresAt }, '图片已完成校验，需在 24 小时内关联观测');
  } catch (error) {
    if (stored) await removeEvidenceFile(stored.storagePath).catch(() => undefined);
    await db.update(mediaUploadSessions).set({ status: 'uploading', updatedAt: new Date() }).where(and(
      eq(mediaUploadSessions.id, session.id),
      eq(mediaUploadSessions.status, 'assembling'),
    ));
    const code = error instanceof Error ? error.message : 'MEDIA_COMPLETE_FAILED';
    return fail(c, 422, code, '整文件校验失败');
  }
});

mediaRouter.delete('/uploads/:uploadId', async (c) => {
  const session = await ownedUpload(c.req.param('uploadId'), c.get('installationId'));
  if (!session) return fail(c, 404, 'MEDIA_UPLOAD_NOT_FOUND', '上传会话不存在');
  await removeUploadDirectory(session.id);
  await db.delete(mediaUploadSessions).where(eq(mediaUploadSessions.id, session.id));
  return ok(c, { deleted: true });
});

mediaRouter.delete('/:id', async (c) => {
  const [media] = await db.select().from(evidenceMedia).where(and(eq(evidenceMedia.id, c.req.param('id')), eq(evidenceMedia.installationId, c.get('installationId')), isNull(evidenceMedia.deletedAt))).limit(1);
  if (!media) return fail(c, 404, 'MEDIA_NOT_FOUND', '媒体不存在');
  await removeEvidenceFile(media.storagePath);
  await db.update(evidenceMedia).set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() }).where(eq(evidenceMedia.id, media.id));
  return ok(c, { deleted: true });
});

async function ownedUpload(uploadId: string, installationId: string) {
  const parsed = z.uuid().safeParse(uploadId);
  if (!parsed.success) return null;
  const [session] = await db.select().from(mediaUploadSessions).where(and(eq(mediaUploadSessions.id, uploadId), eq(mediaUploadSessions.installationId, installationId))).limit(1);
  return session ?? null;
}

function uploadResponse(session: typeof mediaUploadSessions.$inferSelect) {
  return {
    upload_id: session.id,
    status: session.status,
    part_size: MEDIA_PART_BYTES,
    total_parts: session.totalParts,
    expires_at: session.expiresAt,
  };
}
