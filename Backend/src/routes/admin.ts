import argon2 from 'argon2';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { ADMIN_COOKIE_NAME, adminTokenHash, requireAdmin, requireAdminCsrf } from '../auth/admin.js';
import { getEnv } from '../config/env.js';
import {
  adminRoles,
  adminSessions,
  adminUsers,
  agentTasks,
  auditEvents,
  communityReviewTasks,
  db,
  evidenceMedia,
  featureDefinitions,
  installationAccounts,
  observations,
  places,
  platformLinkConfigs,
  queryClient,
  verificationRecords,
} from '../db/index.js';
import { randomToken } from '../lib/crypto.js';
import { fail, ok } from '../lib/api-response.js';
import { taskQueue } from '../queue/task-queue.js';
import type { AppBindings } from '../types.js';

const loginSchema = z.object({ username: z.string().min(3).max(64), password: z.string().min(6).max(256) });
const placeSchema = z.object({
  name: z.string().min(1).max(160),
  category_code: z.string().min(1).max(64),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  address: z.string().max(1000).optional(),
});
const platformSchema = z.object({
  platform: z.string().min(1).max(32),
  capability: z.string().min(1).max(64),
  mode: z.enum(['app_uri', 'web', 'clipboard', 'authorized_api', 'unavailable']),
  app_uri_template: z.string().max(2000).optional(),
  web_url_template: z.url().optional(),
  allowed_hosts: z.array(z.string().min(1).max(255)).max(20).default([]),
  enabled: z.boolean(),
});

export const adminAuthRouter = new Hono<AppBindings>();
export const adminRouter = new Hono<AppBindings>();

adminAuthRouter.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 401, 'ADMIN_LOGIN_FAILED', '用户名或密码错误');
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.username, parsed.data.username)).limit(1);
  if (!user || user.status !== 'active' || (user.lockedUntil && user.lockedUntil > new Date())) return fail(c, 401, 'ADMIN_LOGIN_FAILED', '用户名或密码错误');
  const valid = await argon2.verify(user.passwordHash, parsed.data.password).catch(() => false);
  if (!valid) {
    const failures = user.failedLoginCount + 1;
    await db.update(adminUsers).set({ failedLoginCount: failures, lockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null, updatedAt: new Date() }).where(eq(adminUsers.id, user.id));
    return fail(c, 401, 'ADMIN_LOGIN_FAILED', '用户名或密码错误');
  }
  const sessionToken = randomToken(48);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await db.insert(adminSessions).values({ adminUserId: user.id, tokenHash: adminTokenHash(sessionToken), csrfHash: adminTokenHash(csrfToken), expiresAt });
  await db.update(adminUsers).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(adminUsers.id, user.id));
  setCookie(c, ADMIN_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: getEnv().APP_ENV !== 'development',
    sameSite: 'Strict',
    path: '/api/v1/admin',
    expires: expiresAt,
  });
  await audit(c, user.id, 'admin.login', 'admin_user', user.id);
  return ok(c, { username: user.username, csrf_token: csrfToken, expires_at: expiresAt });
});

adminAuthRouter.post('/logout', requireAdmin, requireAdminCsrf, async (c) => {
  const token = getCookie(c, ADMIN_COOKIE_NAME);
  if (token) await db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.tokenHash, adminTokenHash(token)), isNull(adminSessions.revokedAt)));
  deleteCookie(c, ADMIN_COOKIE_NAME, { path: '/api/v1/admin' });
  await audit(c, c.get('adminUserId'), 'admin.logout', 'admin_user', c.get('adminUserId'));
  return ok(c, { logged_out: true });
});

adminRouter.use('*', requireAdmin);
adminRouter.use('*', requireAdminCsrf);

const requirePermission = (permission: string) => createMiddleware<AppBindings>(async (c, next) => {
  const permissions = c.get('adminPermissions');
  if (!permissions.includes('*') && !permissions.includes(permission)) {
    return fail(c, 403, 'ADMIN_PERMISSION_DENIED', '没有执行此操作的权限');
  }
  await next();
});

adminRouter.get('/dashboard', requirePermission('dashboard.read'), async (c) => {
  const now = new Date();
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [[pendingEvidence], [pendingReviews], [failedTasks], [expiringEvidence], queueCounts] = await Promise.all([
    db.select({ value: count() }).from(observations).where(eq(observations.moderationStatus, 'pending')),
    db.select({ value: count() }).from(communityReviewTasks).where(eq(communityReviewTasks.status, 'pending_review')),
    db.select({ value: count() }).from(agentTasks).where(eq(agentTasks.status, 'failed')),
    db.select({ value: count() }).from(observations).where(and(sql`${observations.expiresAt} > ${now}`, sql`${observations.expiresAt} <= ${soon}`)),
    taskQueue.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed'),
  ]);
  return ok(c, {
    region: { province_code: '360000', label: '江西省' },
    metrics: {
      pending_evidence: pendingEvidence?.value ?? 0,
      pending_reviews: pendingReviews?.value ?? 0,
      failed_tasks: failedTasks?.value ?? 0,
      expiring_evidence: expiringEvidence?.value ?? 0,
    },
    queue: queueCounts,
    sources: [
      { id: 'amap', label: '高德地图', configured: Boolean(getEnv().AMAP_WEB_SERVICE_KEY) },
      { id: 'qwen', label: 'Qwen 模型', configured: Boolean(getEnv().DASHSCOPE_API_KEY) },
      { id: 'postgresql', label: 'PostgreSQL', configured: true },
      { id: 'redis_bullmq', label: 'Redis / BullMQ', configured: true },
    ],
  });
});

adminRouter.get('/places', requirePermission('places.read'), async (c) => ok(c, await db.select().from(places).orderBy(desc(places.updatedAt)).limit(100)));
adminRouter.post('/places', requirePermission('places.write'), async (c) => {
  const parsed = placeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLACE_INVALID', '地点参数无效');
  const rows = await queryClient<Array<{ id: string }>>`
    INSERT INTO places (name, category_code, location, longitude, latitude, address, province_code)
    VALUES (${parsed.data.name}, ${parsed.data.category_code}, ST_SetSRID(ST_MakePoint(${parsed.data.longitude}, ${parsed.data.latitude}), 4326), ${parsed.data.longitude}, ${parsed.data.latitude}, ${parsed.data.address ?? null}, '360000')
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) return fail(c, 500, 'PLACE_CREATE_FAILED', '地点创建失败');
  await audit(c, c.get('adminUserId'), 'place.created', 'place', id);
  return ok(c, { id }, '地点已创建', 201);
});

adminRouter.patch('/places/:id', requirePermission('places.write'), async (c) => {
  const parsed = placeSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLACE_INVALID', '地点参数无效');
  const update = parsed.data;
  const [existing] = await db.select().from(places).where(eq(places.id, c.req.param('id'))).limit(1);
  if (!existing) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在');
  const longitude = update.longitude ?? Number(existing.longitude);
  const latitude = update.latitude ?? Number(existing.latitude);
  await queryClient`
    UPDATE places SET
      name = ${update.name ?? existing.name},
      category_code = ${update.category_code ?? existing.categoryCode},
      longitude = ${longitude}, latitude = ${latitude},
      location = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326),
      address = ${update.address ?? existing.address}, updated_at = NOW()
    WHERE id = ${existing.id}
  `;
  await audit(c, c.get('adminUserId'), 'place.updated', 'place', existing.id);
  return ok(c, { id: existing.id });
});

adminRouter.get('/reviews', requirePermission('reviews.read'), async (c) => {
  const rows = await db.select({ observation: observations, placeName: places.name }).from(observations).innerJoin(places, eq(observations.placeId, places.id)).orderBy(desc(observations.createdAt)).limit(100);
  return ok(c, rows);
});

adminRouter.post('/reviews/:id/decision', requirePermission('reviews.decide'), async (c) => {
  const parsed = z.object({ decision: z.enum(['accepted', 'rejected', 'pending']), reason: z.string().min(3).max(1000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'REVIEW_DECISION_INVALID', '审核结论或理由无效');
  const [record] = await db.update(observations).set({ moderationStatus: parsed.data.decision, evidenceGrade: parsed.data.decision === 'accepted' ? 'C' : 'U', updatedAt: new Date() }).where(eq(observations.id, c.req.param('id'))).returning();
  if (!record) return fail(c, 404, 'OBSERVATION_NOT_FOUND', '观测不存在');
  await audit(c, c.get('adminUserId'), 'observation.moderated', 'observation', record.id, parsed.data.reason, { decision: parsed.data.decision });
  return ok(c, record);
});

adminRouter.get('/platform-links', requirePermission('platform_links.read'), async (c) => ok(c, await db.select().from(platformLinkConfigs).orderBy(platformLinkConfigs.platform)));
adminRouter.post('/platform-links', requirePermission('platform_links.manage'), async (c) => {
  const parsed = platformSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLATFORM_LINK_INVALID', '平台配置无效');
  const [record] = await db.insert(platformLinkConfigs).values({
    platform: parsed.data.platform,
    capability: parsed.data.capability,
    mode: parsed.data.mode,
    appUriTemplate: parsed.data.app_uri_template,
    webUrlTemplate: parsed.data.web_url_template,
    allowedHosts: parsed.data.allowed_hosts,
    enabled: parsed.data.enabled,
  }).onConflictDoUpdate({
    target: [platformLinkConfigs.platform, platformLinkConfigs.capability],
    set: { mode: parsed.data.mode, appUriTemplate: parsed.data.app_uri_template, webUrlTemplate: parsed.data.web_url_template, allowedHosts: parsed.data.allowed_hosts, enabled: parsed.data.enabled, verifiedAt: new Date(), updatedAt: new Date() },
  }).returning();
  await audit(c, c.get('adminUserId'), 'platform_link.saved', 'platform_link_config', record?.id);
  return ok(c, record, '平台配置已保存');
});

adminRouter.get('/tasks', requirePermission('tasks.read'), async (c) => ok(c, await db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(100)));
adminRouter.get('/community-reviews', requirePermission('reviews.read'), async (c) => ok(c, await db.select({
  id: communityReviewTasks.id,
  placeName: places.name,
  featureKey: featureDefinitions.featureKey,
  status: communityReviewTasks.status,
  reason: communityReviewTasks.reason,
  consensusOutcome: communityReviewTasks.consensusOutcome,
  consensusSnapshot: communityReviewTasks.consensusSnapshot,
  locationRadiusMeters: communityReviewTasks.locationRadiusMeters,
  createdAt: communityReviewTasks.createdAt,
  updatedAt: communityReviewTasks.updatedAt,
}).from(communityReviewTasks).innerJoin(places, eq(communityReviewTasks.placeId, places.id)).innerJoin(featureDefinitions, eq(communityReviewTasks.featureDefinitionId, featureDefinitions.id)).orderBy(desc(communityReviewTasks.updatedAt)).limit(100)));
adminRouter.get('/verifications', requirePermission('verifications.read'), async (c) => ok(c, await db.select({
  id: verificationRecords.id,
  scene: verificationRecords.scene,
  status: verificationRecords.status,
  confidence: verificationRecords.confidence,
  riskLevel: verificationRecords.riskLevel,
  modelName: verificationRecords.modelName,
  originalMediaStored: verificationRecords.originalMediaStored,
  temporaryMediaDeletedAt: verificationRecords.temporaryMediaDeletedAt,
  failureCode: verificationRecords.failureCode,
  createdAt: verificationRecords.createdAt,
}).from(verificationRecords).orderBy(desc(verificationRecords.createdAt)).limit(100)));
adminRouter.get('/installations', requirePermission('installations.read'), async (c) => ok(c, await db.select({
  id: installationAccounts.id,
  installationGuid: installationAccounts.installationGuid,
  status: installationAccounts.status,
  acceptedContributionCount: installationAccounts.acceptedContributionCount,
  lastSeenAt: installationAccounts.lastSeenAt,
  createdAt: installationAccounts.createdAt,
}).from(installationAccounts).orderBy(desc(installationAccounts.lastSeenAt)).limit(100)));
adminRouter.get('/admin-users', requirePermission('admin_users.read'), async (c) => ok(c, await db.select({ id: adminUsers.id, username: adminUsers.username, status: adminUsers.status, roleId: adminUsers.roleId, lastLoginAt: adminUsers.lastLoginAt, createdAt: adminUsers.createdAt }).from(adminUsers).orderBy(adminUsers.username)));
adminRouter.post('/admin-users', requirePermission('admin_users.manage'), async (c) => {
  const parsed = z.object({ username: z.string().min(3).max(64), password: z.string().min(12).max(256), role_id: z.uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_USER_INVALID', '管理员参数无效');
  const [user] = await db.insert(adminUsers).values({ username: parsed.data.username, passwordHash: await argon2.hash(parsed.data.password, { type: argon2.argon2id }), roleId: parsed.data.role_id }).returning({ id: adminUsers.id, username: adminUsers.username });
  await audit(c, c.get('adminUserId'), 'admin_user.created', 'admin_user', user?.id);
  return ok(c, user, '管理员已创建', 201);
});
adminRouter.get('/roles', requirePermission('admin_users.read'), async (c) => ok(c, await db.select().from(adminRoles).orderBy(adminRoles.code)));
adminRouter.get('/audit-events', requirePermission('audit.read'), async (c) => ok(c, await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(200)));
adminRouter.get('/media', requirePermission('media.read'), async (c) => ok(c, await db.select({ id: evidenceMedia.id, mimeType: evidenceMedia.mimeType, byteSize: evidenceMedia.byteSize, status: evidenceMedia.status, redactionConfirmed: evidenceMedia.redactionConfirmed, linkedAt: evidenceMedia.linkedAt, expiresAt: evidenceMedia.expiresAt, deletedAt: evidenceMedia.deletedAt, createdAt: evidenceMedia.createdAt }).from(evidenceMedia).orderBy(desc(evidenceMedia.createdAt)).limit(100)));
adminRouter.get('/system', requirePermission('system.read'), async (c) => ok(c, {
  environment: getEnv().APP_ENV,
  public_urls: { api: getEnv().APP_PUBLIC_URL, admin: getEnv().ADMIN_PUBLIC_URL },
  models: { agent: getEnv().AGENT_MODEL, vision: getEnv().VISION_MODEL, asr: getEnv().ASR_MODEL, tts: getEnv().TTS_MODEL },
  media: { maximum_image_bytes: getEnv().MEDIA_MAX_IMAGE_BYTES, quota_bytes: getEnv().MEDIA_QUOTA_BYTES, directories_isolated: true },
  events: { sse_resume_window_seconds: getEnv().SSE_RESUME_WINDOW_SECONDS },
  voice: { maximum_session_seconds: getEnv().VOICE_WS_MAX_SESSION_SECONDS },
  queue: { name: taskQueue.name, worker_concurrency: getEnv().WORKER_CONCURRENCY },
}));

async function audit(
  c: Parameters<typeof ok>[0],
  actorId: string,
  action: string,
  targetType: string,
  targetId?: string,
  reason?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditEvents).values({ actorType: 'admin', actorId, action, targetType, targetId, reason, metadata, requestId: c.get('requestId') as string });
}
