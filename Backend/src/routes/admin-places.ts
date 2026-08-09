import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdminPermission } from '../auth/admin-permission.js';
import { fail, ok } from '../lib/api-response.js';
import {
  createAdminPlace,
  listAdminPlaceTargets,
  listAdminPlaces,
  mergeAdminPlace,
  setAdminPlaceStatus,
  updateAdminPlace,
  type PlaceMutationResult,
} from '../services/admin-place.js';
import type { AppBindings } from '../types.js';

const placeFieldsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category_code: z.string().trim().min(1).max(64),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  address: z.string().trim().max(1000).nullable().optional(),
});
const mutationContextSchema = z.object({ reason: z.string().trim().min(6).max(1000) });
const createSchema = placeFieldsSchema.extend(mutationContextSchema.shape);
const updateSchema = placeFieldsSchema.extend({
  expected_updated_at: z.iso.datetime(),
  reason: mutationContextSchema.shape.reason,
});
const statusSchema = z.object({
  status: z.enum(['active', 'disabled']),
  expected_updated_at: z.iso.datetime(),
  reason: mutationContextSchema.shape.reason,
});
const mergeSchema = z.object({
  target_place_id: z.uuid(),
  expected_source_updated_at: z.iso.datetime(),
  expected_target_updated_at: z.iso.datetime(),
  reason: mutationContextSchema.shape.reason,
});
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(10).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'disabled', 'merged']).optional(),
});
const targetListSchema = z.object({
  q: z.string().trim().max(120).optional(),
  exclude_place_id: z.uuid().optional(),
});

export const adminPlacesRouter = new Hono<AppBindings>();

adminPlacesRouter.get('/', requireAdminPermission('places.read'), async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 422, 'PLACE_LIST_INVALID', '地点列表筛选参数无效');
  return ok(c, await listAdminPlaces({
    page: parsed.data.page,
    pageSize: parsed.data.page_size,
    ...(parsed.data.q ? { query: parsed.data.q } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  }));
});

adminPlacesRouter.get('/merge-targets', requireAdminPermission('places.read'), async (c) => {
  const parsed = targetListSchema.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 422, 'PLACE_TARGET_LIST_INVALID', '合并目标筛选参数无效');
  return ok(c, await listAdminPlaceTargets({
    ...(parsed.data.q ? { query: parsed.data.q } : {}),
    ...(parsed.data.exclude_place_id ? { excludePlaceId: parsed.data.exclude_place_id } : {}),
  }));
});

adminPlacesRouter.post('/', requireAdminPermission('places.write'), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLACE_INVALID', '地点字段或操作理由无效');
  const created = await createAdminPlace({
    actorId: c.get('adminUserId'), requestId: c.get('requestId'), reason: parsed.data.reason,
    name: parsed.data.name, categoryCode: parsed.data.category_code,
    longitude: parsed.data.longitude, latitude: parsed.data.latitude, address: parsed.data.address ?? null,
  });
  return ok(c, { id: created.id, updated_at: created.updatedAt }, '地点已创建', 201);
});

adminPlacesRouter.patch('/:id', requireAdminPermission('places.write'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'PLACE_ID_INVALID', '地点 ID 无效');
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLACE_INVALID', '地点字段、版本或操作理由无效');
  const result = await updateAdminPlace({
    actorId: c.get('adminUserId'), requestId: c.get('requestId'), reason: parsed.data.reason,
    placeId: c.req.param('id'), expectedUpdatedAt: new Date(parsed.data.expected_updated_at),
    name: parsed.data.name, categoryCode: parsed.data.category_code,
    longitude: parsed.data.longitude, latitude: parsed.data.latitude, address: parsed.data.address ?? null,
  });
  return result.ok ? ok(c, result.value, '地点已更新') : placeFailure(c, result);
});

adminPlacesRouter.post('/:id/status', requireAdminPermission('places.write'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'PLACE_ID_INVALID', '地点 ID 无效');
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLACE_STATUS_INVALID', '地点状态、版本或操作理由无效');
  const result = await setAdminPlaceStatus({
    actorId: c.get('adminUserId'), requestId: c.get('requestId'), reason: parsed.data.reason,
    placeId: c.req.param('id'), status: parsed.data.status, expectedUpdatedAt: new Date(parsed.data.expected_updated_at),
  });
  return result.ok ? ok(c, result.value, '地点状态已更新') : placeFailure(c, result);
});

adminPlacesRouter.post('/:id/merge', requireAdminPermission('places.write'), async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return fail(c, 422, 'PLACE_ID_INVALID', '地点 ID 无效');
  const parsed = mergeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PLACE_MERGE_INVALID', '合并目标、版本或操作理由无效');
  const result = await mergeAdminPlace({
    actorId: c.get('adminUserId'), requestId: c.get('requestId'), reason: parsed.data.reason,
    sourcePlaceId: c.req.param('id'), targetPlaceId: parsed.data.target_place_id,
    expectedSourceUpdatedAt: new Date(parsed.data.expected_source_updated_at),
    expectedTargetUpdatedAt: new Date(parsed.data.expected_target_updated_at),
  });
  return result.ok ? ok(c, result.value, '地点已合并到 canonical 记录') : placeFailure(c, result);
});

function placeFailure(c: Parameters<typeof fail>[0], result: Extract<PlaceMutationResult<unknown>, { ok: false }>) {
  const status = result.code === 'PLACE_NOT_FOUND' ? 404
    : result.code === 'PLACE_CONFLICT' || result.code === 'PLACE_MERGED_READ_ONLY' || result.code === 'PLACE_CANONICAL_TARGET_REQUIRED' || result.code === 'PLACE_MERGE_TARGET_INVALID' ? 409
      : 422;
  return fail(c, status, result.code, result.message);
}
