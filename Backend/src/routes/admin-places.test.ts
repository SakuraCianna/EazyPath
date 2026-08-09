import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const placeService = vi.hoisted(() => ({
  createAdminPlace: vi.fn(),
  listAdminPlaceTargets: vi.fn(),
  listAdminPlaces: vi.fn(),
  mergeAdminPlace: vi.fn(),
  setAdminPlaceStatus: vi.fn(),
  updateAdminPlace: vi.fn(),
}));

vi.mock('../services/admin-place.js', () => placeService);

import { adminPlacesRouter } from './admin-places.js';
import type { AppBindings } from '../types.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = '00000000-0000-4000-8000-000000000010';
const TARGET_ID = '00000000-0000-4000-8000-000000000020';
const UPDATED_AT = '2026-08-09T00:00:00.000Z';

function testApp(permissions: string[]) {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_place_test');
    c.set('adminUserId', ADMIN_ID);
    c.set('adminPermissions', permissions);
    await next();
  });
  app.route('/places', adminPlacesRouter);
  return app;
}

describe('管理员地点治理路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    placeService.listAdminPlaces.mockResolvedValue([]);
    placeService.listAdminPlaceTargets.mockResolvedValue([]);
    placeService.createAdminPlace.mockResolvedValue({ id: SOURCE_ID, updatedAt: new Date(UPDATED_AT) });
  });

  it('读取地点需要 places.read 权限', async () => {
    const response = await testApp([]).request('/places');
    expect(response.status).toBe(403);
    expect(placeService.listAdminPlaces).not.toHaveBeenCalled();
  });

  it('地点列表把分页与服务端筛选传给查询服务', async () => {
    placeService.listAdminPlaces.mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 50, summary: {} });
    const response = await testApp(['places.read']).request('/places?page=2&page_size=50&q=%E5%8D%97%E6%98%8C&status=active');
    expect(response.status).toBe(200);
    expect(placeService.listAdminPlaces).toHaveBeenCalledWith({ page: 2, pageSize: 50, query: '南昌', status: 'active' });
  });

  it('新增地点要求完整字段和审计理由', async () => {
    const response = await testApp(['places.write']).request('/places', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '南昌站', category_code: 'station', longitude: 115.9, latitude: 28.6 }),
    });
    expect(response.status).toBe(422);
    expect(placeService.createAdminPlace).not.toHaveBeenCalled();
  });

  it('编辑地点传递全部字段、理由和乐观锁', async () => {
    placeService.updateAdminPlace.mockResolvedValue({ ok: true, value: { id: SOURCE_ID, updatedAt: new Date(UPDATED_AT) } });
    const response = await testApp(['places.write']).request(`/places/${SOURCE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '南昌站', category_code: 'station', longitude: 115.9, latitude: 28.6, address: '江西省南昌市',
        expected_updated_at: UPDATED_AT, reason: '根据现场核对修正地点主数据',
      }),
    });
    expect(response.status).toBe(200);
    expect(placeService.updateAdminPlace).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN_ID, placeId: SOURCE_ID, expectedUpdatedAt: new Date(UPDATED_AT), reason: '根据现场核对修正地点主数据',
    }));
  });

  it('乐观锁冲突保持稳定的 409 错误码', async () => {
    placeService.setAdminPlaceStatus.mockResolvedValue({ ok: false, code: 'PLACE_CONFLICT', message: '地点已更新' });
    const response = await testApp(['places.write']).request(`/places/${SOURCE_ID}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled', expected_updated_at: UPDATED_AT, reason: '现场确认该地点已经停止运营' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('PLACE_CONFLICT');
  });

  it('合并地点同时传递来源和 canonical 目标版本', async () => {
    placeService.mergeAdminPlace.mockResolvedValue({ ok: true, value: { sourceId: SOURCE_ID, targetId: TARGET_ID, mergedAt: new Date() } });
    const response = await testApp(['places.write']).request(`/places/${SOURCE_ID}/merge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target_place_id: TARGET_ID,
        expected_source_updated_at: UPDATED_AT,
        expected_target_updated_at: UPDATED_AT,
        reason: '确认两个记录指向同一真实地点并保留目标记录',
      }),
    });
    expect(response.status).toBe(200);
    expect(placeService.mergeAdminPlace).toHaveBeenCalledWith(expect.objectContaining({
      sourcePlaceId: SOURCE_ID, targetPlaceId: TARGET_ID,
      expectedSourceUpdatedAt: new Date(UPDATED_AT), expectedTargetUpdatedAt: new Date(UPDATED_AT),
    }));
  });
});
