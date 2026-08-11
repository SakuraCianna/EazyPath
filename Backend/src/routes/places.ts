import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  db,
  facilities,
  featureDefinitions,
  observations,
  places,
  placeUnits,
  queryClient,
} from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { AmapUpstreamError, searchAmapPlaces, type AmapPlace } from '../services/amap.js';
import { lockCanonicalPlaceForRead, resolveActivePlace } from '../services/place-resolution.js';
import type { AppBindings } from '../types.js';

export const placesRouter = new Hono<AppBindings>();
placesRouter.use('*', requireUser);

placesRouter.get('/feature-definitions', async (c) => {
  const rows = await db.select({
    feature_key: featureDefinitions.featureKey,
    display_name: featureDefinitions.displayName,
    value_type: featureDefinitions.valueType,
    unit: featureDefinitions.unit,
    target_types: featureDefinitions.targetTypes,
    schema_version: featureDefinitions.schemaVersion,
  }).from(featureDefinitions).where(eq(featureDefinitions.active, true)).orderBy(featureDefinitions.displayName);
  return ok(c, rows.filter((row) => row.target_types.includes('place')));
});

placesRouter.get('/search', async (c) => {
  const query = z.object({
    q: z.string().trim().min(1).max(80),
    region: z.string().trim().min(1).max(80).default('江西省'),
    type: z.string().max(64).optional(),
  }).safeParse(c.req.query());
  if (!query.success) return fail(c, 422, 'PLACE_SEARCH_INVALID', '地点搜索参数无效');
  try {
    const results = await searchAmapPlaces(query.data.q, query.data.region, query.data.type);
    const persistedRows = await Promise.all(results.map(upsertAmapPlace));
    const persisted = [...new Map(persistedRows.filter((item) => item !== null).map((item) => [item.id, item])).values()];
    const ids = persisted.map((item) => item.id);
    const evidence = ids.length === 0 ? [] : await db.select({ placeId: observations.placeId, grade: observations.evidenceGrade, expiresAt: observations.expiresAt }).from(observations).where(and(inArray(observations.placeId, ids), eq(observations.moderationStatus, 'approved'), isNull(observations.withdrawnAt)));
    const evidenceByPlace = new Map<string, Array<{ grade: string; expiresAt: Date | null }>>();
    for (const item of evidence) evidenceByPlace.set(item.placeId, [...(evidenceByPlace.get(item.placeId) ?? []), { grade: item.grade, expiresAt: item.expiresAt }]);
    return ok(c, persisted.map((item) => ({
      id: item.id,
      name: item.name,
      category_code: item.category_code,
      longitude: item.longitude,
      latitude: item.latitude,
      address: item.address,
      accessibility: summarizeEvidence(evidenceByPlace.get(item.id) ?? []),
    })));
  } catch (error) {
    if (error instanceof AmapUpstreamError) return fail(c, 502, 'AMAP_UNAVAILABLE', '高德地点服务暂时不可用', { retryable: error.retryable, retry_after_ms: 2_000 });
    throw error;
  }
});

placesRouter.get('/:placeId', async (c) => {
  const requestedPlaceId = c.req.param('placeId');
  if (!z.uuid().safeParse(requestedPlaceId).success) return fail(c, 422, 'PLACE_ID_INVALID', '地点 ID 无效');
  const candidate = await resolveActivePlace(requestedPlaceId);
  if (!candidate) {
    const [exists] = await db.select({ id: places.id }).from(places).where(eq(places.id, requestedPlaceId)).limit(1);
    return exists
      ? fail(c, 410, 'PLACE_UNAVAILABLE', '地点已停用或 canonical 记录不可用')
      : fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在');
  }
  const result = await db.transaction(async (tx) => {
    const lockedPlace = await lockCanonicalPlaceForRead(tx, candidate.id);
    if (!lockedPlace) return undefined;
    const [place] = await tx.select().from(places).where(eq(places.id, lockedPlace.id)).limit(1);
    if (!place) return undefined;
    const [units, facilityRows, evidenceRows] = await Promise.all([
      tx.select({
        id: placeUnits.id,
        parent_unit_id: placeUnits.parentUnitId,
        unit_type: placeUnits.unitType,
        name: placeUnits.name,
      }).from(placeUnits).where(eq(placeUnits.placeId, place.id)),
      tx.select({
        id: facilities.id,
        place_unit_id: facilities.placeUnitId,
        facility_type: facilities.facilityType,
        name: facilities.name,
      }).from(facilities).where(eq(facilities.placeId, place.id)),
      tx.select({
      id: observations.id,
      feature_key: featureDefinitions.featureKey,
      display_name: featureDefinitions.displayName,
      value: observations.valueJson,
      source: observations.evidenceSource,
      grade: observations.evidenceGrade,
      moderation_status: observations.moderationStatus,
      freshness_status: observations.freshnessStatus,
      observed_at: observations.observedAt,
      expires_at: observations.expiresAt,
      created_at: observations.createdAt,
      }).from(observations).innerJoin(featureDefinitions, eq(observations.featureDefinitionId, featureDefinitions.id)).where(and(
        eq(observations.placeId, place.id),
        eq(observations.moderationStatus, 'approved'),
        isNull(observations.withdrawnAt),
      )).orderBy(desc(observations.createdAt)).limit(201),
    ]);
    return { place, units, facilityRows, evidenceRows: evidenceRows.slice(0, 200), evidenceTimelineHasMore: evidenceRows.length > 200 };
  });
  if (!result) return fail(c, 409, 'PLACE_STATE_CHANGED', '地点状态刚刚发生变化，请刷新后重试');
  return ok(c, {
    place: {
      id: result.place.id,
      name: result.place.name,
      category_code: result.place.categoryCode,
      longitude: Number(result.place.longitude),
      latitude: Number(result.place.latitude),
      address: result.place.address,
      external_source: result.place.externalSource,
      status: result.place.status,
    },
    canonical_place_id: result.place.id,
    requested_place_id: requestedPlaceId,
    units: result.units,
    facilities: result.facilityRows,
    evidence_timeline: result.evidenceRows,
    evidence_timeline_has_more: result.evidenceTimelineHasMore,
  });
});

async function upsertAmapPlace(place: AmapPlace) {
  const rows = await queryClient<Array<{
    id: string;
    name: string;
    category_code: string;
    longitude: string;
    latitude: string;
    address: string | null;
    external_id: string;
    status: string;
    merged_into_place_id: string | null;
  }>>`
    INSERT INTO places (
      external_source, external_id, name, category_code, location,
      longitude, latitude, address, province_code, source_updated_at, updated_at
    ) VALUES (
      'amap', ${place.externalId}, ${place.name}, ${place.category},
      ST_SetSRID(ST_MakePoint(${place.longitude}, ${place.latitude}), 4326),
      ${place.longitude}, ${place.latitude}, ${place.address}, '360000', NOW(), NOW()
    )
    ON CONFLICT (external_source, external_id) DO UPDATE SET
      name = CASE WHEN places.admin_override_at IS NULL THEN EXCLUDED.name ELSE places.name END,
      category_code = CASE WHEN places.admin_override_at IS NULL THEN EXCLUDED.category_code ELSE places.category_code END,
      location = CASE WHEN places.admin_override_at IS NULL THEN EXCLUDED.location ELSE places.location END,
      longitude = CASE WHEN places.admin_override_at IS NULL THEN EXCLUDED.longitude ELSE places.longitude END,
      latitude = CASE WHEN places.admin_override_at IS NULL THEN EXCLUDED.latitude ELSE places.latitude END,
      address = CASE WHEN places.admin_override_at IS NULL THEN EXCLUDED.address ELSE places.address END,
      source_updated_at = NOW(),
      updated_at = CASE WHEN places.admin_override_at IS NULL THEN NOW() ELSE places.updated_at END
    RETURNING id, name, category_code, longitude, latitude, address, external_id, status, merged_into_place_id
  `;
  const row = rows[0];
  if (!row) throw new Error('PLACE_UPSERT_FAILED');
  if (row.status === 'disabled') return null;
  if (row.status === 'merged' && row.merged_into_place_id) {
    const canonicalRows = await queryClient<Array<{
      id: string; name: string; category_code: string; longitude: string; latitude: string; address: string | null;
      external_source: string | null; external_id: string | null;
    }>>`
      SELECT id, name, category_code, longitude, latitude, address, external_source, external_id
      FROM places WHERE id = ${row.merged_into_place_id} AND status = 'active' LIMIT 1
    `;
    const canonical = canonicalRows[0];
    if (!canonical) return null;
    return {
      id: canonical.id,
      external_source: canonical.external_source,
      external_id: canonical.external_id,
      name: canonical.name,
      category_code: canonical.category_code,
      longitude: Number(canonical.longitude),
      latitude: Number(canonical.latitude),
      address: canonical.address,
    };
  }
  return {
    id: row.id,
    external_source: 'amap',
    external_id: row.external_id,
    name: row.name,
    category_code: row.category_code,
    longitude: Number(row.longitude),
    latitude: Number(row.latitude),
    address: row.address,
  };
}

function summarizeEvidence(rows: Array<{ grade: string; expiresAt: Date | null }>) {
  const active = rows.filter((row) => !row.expiresAt || row.expiresAt > new Date());
  if (active.length === 0) return { status: 'unknown', verified_feature_count: 0, disclosure: '高德 POI 本身不包含轮椅友好结论' };
  const grade = active.some((row) => row.grade === 'A') ? 'A' : active.some((row) => row.grade === 'B') ? 'B' : 'C';
  return { status: 'evidence_available', highest_grade: grade, verified_feature_count: active.length };
}
