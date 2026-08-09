import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireAdminCsrf } from '../auth/admin.js';
import { requireAdminPermission } from '../auth/admin-permission.js';
import { getEnv } from '../config/env.js';
import {
  adminRoles,
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
} from '../db/index.js';
import { ADMIN_PERMISSION_CODES } from '../domain/admin-security.js';
import { fail, ok } from '../lib/api-response.js';
import { taskQueue } from '../queue/task-queue.js';
import {
  createAdminRole,
  createAdminUser,
  revokeManagedAdminSessions,
  updateAdminRole,
  updateAdminUserAccess,
  type AccessResult,
} from '../services/admin-access.js';
import type { AppBindings } from '../types.js';
import { adminReviewsRouter } from './admin-reviews.js';
import { adminPlacesRouter } from './admin-places.js';

const platformSchema = z.object({
  platform: z.string().min(1).max(32),
  capability: z.string().min(1).max(64),
  mode: z.enum(['app_uri', 'web', 'clipboard', 'authorized_api', 'unavailable']),
  app_uri_template: z.string().max(2000).optional(),
  web_url_template: z.url().optional(),
  allowed_hosts: z.array(z.string().min(1).max(255)).max(20).default([]),
  enabled: z.boolean(),
});
const adminUserCreateSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-z0-9._-]+$/),
  password: z.string().min(12).max(256),
  role_id: z.uuid(),
  reason: z.string().min(6).max(1000),
});
const adminUserAccessSchema = z.object({
  role_id: z.uuid().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  reason: z.string().min(6).max(1000),
}).refine((value) => value.role_id !== undefined || value.status !== undefined);
const adminRoleSchema = z.object({
  code: z.string().min(3).max(64).regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(2).max(128),
  permissions: z.array(z.string()).min(1).max(64),
  reason: z.string().min(6).max(1000),
});
const adminRoleUpdateSchema = adminRoleSchema.omit({ code: true });
const adminReasonSchema = z.object({ reason: z.string().min(6).max(1000) });

export const adminRouter = new Hono<AppBindings>();

adminRouter.use('*', requireAdmin);
adminRouter.use('*', requireAdminCsrf);
adminRouter.route('/reviews', adminReviewsRouter);
adminRouter.route('/places', adminPlacesRouter);

adminRouter.get('/dashboard', requireAdminPermission('dashboard.read'), async (c) => {
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

adminRouter.get('/platform-links', requireAdminPermission('platform_links.read'), async (c) => ok(c, await db.select().from(platformLinkConfigs).orderBy(platformLinkConfigs.platform)));
adminRouter.post('/platform-links', requireAdminPermission('platform_links.manage'), async (c) => {
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

adminRouter.get('/tasks', requireAdminPermission('tasks.read'), async (c) => ok(c, await db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(100)));
adminRouter.get('/community-reviews', requireAdminPermission('reviews.read'), async (c) => ok(c, await db.select({
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
adminRouter.get('/installations', requireAdminPermission('installations.read'), async (c) => ok(c, await db.select({
  id: installationAccounts.id,
  installationGuid: installationAccounts.installationGuid,
  status: installationAccounts.status,
  acceptedContributionCount: installationAccounts.acceptedContributionCount,
  lastSeenAt: installationAccounts.lastSeenAt,
  createdAt: installationAccounts.createdAt,
}).from(installationAccounts).orderBy(desc(installationAccounts.lastSeenAt)).limit(100)));
adminRouter.get('/admin-users', requireAdminPermission('admin_users.read'), async (c) => ok(c, await db.select({
  id: adminUsers.id,
  username: adminUsers.username,
  status: adminUsers.status,
  roleId: adminUsers.roleId,
  roleCode: adminRoles.code,
  roleName: adminRoles.name,
  lastLoginAt: adminUsers.lastLoginAt,
  createdAt: adminUsers.createdAt,
}).from(adminUsers).innerJoin(adminRoles, eq(adminUsers.roleId, adminRoles.id)).orderBy(adminUsers.username)));
adminRouter.post('/admin-users', requireAdminPermission('admin_users.manage'), async (c) => {
  const parsed = adminUserCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_USER_INVALID', '管理员参数无效');
  const result = await createAdminUser({
    actorId: c.get('adminUserId'), username: parsed.data.username, password: parsed.data.password,
    roleId: parsed.data.role_id, reason: parsed.data.reason, requestId: c.get('requestId'),
  });
  if (!result.ok) return accessFailure(c, result);
  return ok(c, result.value, '管理员已创建', 201);
});
adminRouter.patch('/admin-users/:id', requireAdminPermission('admin_users.manage'), async (c) => {
  const parsed = adminUserAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_USER_ACCESS_INVALID', '管理员角色、状态或理由无效');
  const result = await updateAdminUserAccess({
    actorId: c.get('adminUserId'), targetId: c.req.param('id'), reason: parsed.data.reason,
    requestId: c.get('requestId'),
    ...(parsed.data.role_id ? { roleId: parsed.data.role_id } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  });
  if (!result.ok) return accessFailure(c, result);
  return ok(c, { id: result.value.id, role_id: result.value.roleId, status: result.value.status });
});
adminRouter.post('/admin-users/:id/revoke-sessions', requireAdminPermission('admin_users.manage'), async (c) => {
  const parsed = adminReasonSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_REASON_INVALID', '必须填写会话撤销理由');
  const result = await revokeManagedAdminSessions({
    actorId: c.get('adminUserId'), targetId: c.req.param('id'), reason: parsed.data.reason,
    requestId: c.get('requestId'),
  });
  if (!result.ok) return accessFailure(c, result);
  return ok(c, { id: result.value.id, sessions_revoked: true });
});
adminRouter.get('/roles', requireAdminPermission('admin_users.read'), async (c) => ok(c, {
  items: await db.select().from(adminRoles).orderBy(adminRoles.code),
  available_permissions: ADMIN_PERMISSION_CODES,
}));
adminRouter.post('/roles', requireAdminPermission('admin_users.manage'), async (c) => {
  const parsed = adminRoleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_ROLE_INVALID', '角色参数无效');
  const result = await createAdminRole({
    actorId: c.get('adminUserId'), code: parsed.data.code, name: parsed.data.name,
    permissions: parsed.data.permissions, reason: parsed.data.reason, requestId: c.get('requestId'),
  });
  if (!result.ok) return accessFailure(c, result);
  return ok(c, result.value, '角色已创建', 201);
});
adminRouter.patch('/roles/:id', requireAdminPermission('admin_users.manage'), async (c) => {
  const parsed = adminRoleUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'ADMIN_ROLE_INVALID', '角色参数无效');
  const result = await updateAdminRole({
    actorId: c.get('adminUserId'), roleId: c.req.param('id'), name: parsed.data.name,
    permissions: parsed.data.permissions, reason: parsed.data.reason, requestId: c.get('requestId'),
  });
  if (!result.ok) return accessFailure(c, result);
  return ok(c, result.value, '角色已更新');
});
adminRouter.get('/audit-events', requireAdminPermission('audit.read'), async (c) => ok(c, await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(200)));
adminRouter.get('/media', requireAdminPermission('media.read'), async (c) => ok(c, await db.select({ id: evidenceMedia.id, mimeType: evidenceMedia.mimeType, byteSize: evidenceMedia.byteSize, status: evidenceMedia.status, redactionConfirmed: evidenceMedia.redactionConfirmed, linkedAt: evidenceMedia.linkedAt, expiresAt: evidenceMedia.expiresAt, deletedAt: evidenceMedia.deletedAt, createdAt: evidenceMedia.createdAt }).from(evidenceMedia).orderBy(desc(evidenceMedia.createdAt)).limit(100)));
adminRouter.get('/system', requireAdminPermission('system.read'), async (c) => ok(c, {
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

function accessFailure(c: Parameters<typeof fail>[0], result: Extract<AccessResult<unknown>, { ok: false }>) {
  const status = result.code.endsWith('_NOT_FOUND') ? 404
    : result.code === 'ADMIN_GRANT_FORBIDDEN' ? 403
    : result.code.endsWith('_EXISTS')
      || result.code === 'ADMIN_SELF_ACCESS_CHANGE_FORBIDDEN'
      || result.code === 'ADMIN_LAST_SUPER_ADMIN_REQUIRED' ? 409
      : 422;
  return fail(c, status, result.code, result.message);
}
