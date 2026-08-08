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
    const persisted = await Promise.all(results.map(upsertAmapPlace));
    const ids = persisted.map((item) => item.id);
    const evidence = ids.length === 0 ? [] : await db.select({ placeId: observations.placeId, grade: observations.evidenceGrade, expiresAt: observations.expiresAt }).from(observations).where(and(inArray(observations.placeId, ids), eq(observations.moderationStatus, 'accepted'), isNull(observations.withdrawnAt)));
    const evidenceByPlace = new Map<string, Array<{ grade: string; expiresAt: Date | null }>>();
    for (const item of evidence) evidenceByPlace.set(item.placeId, [...(evidenceByPlace.get(item.placeId) ?? []), { grade: item.grade, expiresAt: item.expiresAt }]);
    return ok(c, persisted.map((item) => ({
      ...item,
      accessibility: summarizeEvidence(evidenceByPlace.get(item.id) ?? []),
    })));
  } catch (error) {
    if (error instanceof AmapUpstreamError) return fail(c, 502, 'AMAP_UNAVAILABLE', '高德地点服务暂时不可用', { retryable: error.retryable, retry_after_ms: 2_000 });
    throw error;
  }
});

placesRouter.get('/:placeId', async (c) => {
  const [place] = await db.select().from(places).where(eq(places.id, c.req.param('placeId'))).limit(1);
  if (!place) return fail(c, 404, 'PLACE_NOT_FOUND', '地点不存在');
  const [units, facilityRows, evidenceRows] = await Promise.all([
    db.select().from(placeUnits).where(eq(placeUnits.placeId, place.id)),
    db.select().from(facilities).where(eq(facilities.placeId, place.id)),
    db.select({
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
    }).from(observations).innerJoin(featureDefinitions, eq(observations.featureDefinitionId, featureDefinitions.id)).where(and(eq(observations.placeId, place.id), isNull(observations.withdrawnAt))).orderBy(desc(observations.createdAt)),
  ]);
  return ok(c, { place, units, facilities: facilityRows, evidence_timeline: evidenceRows });
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
      name = EXCLUDED.name,
      category_code = EXCLUDED.category_code,
      location = EXCLUDED.location,
      longitude = EXCLUDED.longitude,
      latitude = EXCLUDED.latitude,
      address = EXCLUDED.address,
      source_updated_at = NOW(),
      updated_at = NOW()
    RETURNING id, name, category_code, longitude, latitude, address, external_id
  `;
  const row = rows[0];
  if (!row) throw new Error('PLACE_UPSERT_FAILED');
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
