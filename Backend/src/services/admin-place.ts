import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import {
  auditEvents,
  communityReviewTasks,
  db,
  facilities,
  locationProofs,
  observations,
  places,
  placeUnits,
  verificationRecords,
} from '../db/index.js';

export type PlaceStatus = 'active' | 'disabled' | 'merged';
export type PlaceMutationResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
type PlaceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface PlaceFields {
  name: string;
  categoryCode: string;
  longitude: number;
  latitude: number;
  address?: string | null;
}

interface MutationContext {
  actorId: string;
  reason: string;
  requestId: string;
}

interface AdminPlaceListInput {
  page: number;
  pageSize: number;
  query?: string;
  status?: PlaceStatus;
}

const adminPlaceProjection = {
    id: places.id,
    externalSource: places.externalSource,
    externalId: places.externalId,
    name: places.name,
    categoryCode: places.categoryCode,
    longitude: places.longitude,
    latitude: places.latitude,
    address: places.address,
    provinceCode: places.provinceCode,
    status: places.status,
    mergedIntoPlaceId: places.mergedIntoPlaceId,
    mergedIntoPlaceName: sql<string | null>`(SELECT canonical.name FROM places canonical WHERE canonical.id = ${places.mergedIntoPlaceId})`,
    sourceUpdatedAt: places.sourceUpdatedAt,
    adminOverrideAt: places.adminOverrideAt,
    createdAt: places.createdAt,
    updatedAt: places.updatedAt,
    observationCount: sql<number>`(SELECT COUNT(*) FROM observations o WHERE o.place_id = ${places.id})`.mapWith(Number),
    approvedEvidenceCount: sql<number>`(SELECT COUNT(*) FROM observations o WHERE o.place_id = ${places.id} AND o.moderation_status = 'approved' AND o.withdrawn_at IS NULL)`.mapWith(Number),
    facilityCount: sql<number>`(SELECT COUNT(*) FROM facilities f WHERE f.place_id = ${places.id})`.mapWith(Number),
};

export async function listAdminPlaces(input: AdminPlaceListInput) {
  const search = input.query ? `%${input.query}%` : undefined;
  const condition = and(
    input.status ? eq(places.status, input.status) : undefined,
    search ? or(
      ilike(places.name, search),
      ilike(places.address, search),
      ilike(places.categoryCode, search),
      ilike(places.externalId, search),
    ) : undefined,
  );
  const [items, [total], [summary], [evidence]] = await Promise.all([
    db.select(adminPlaceProjection).from(places).where(condition).orderBy(desc(places.updatedAt), desc(places.id))
      .limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: sql<number>`count(*)`.mapWith(Number) }).from(places).where(condition),
    db.select({
      active: sql<number>`count(*) FILTER (WHERE ${places.status} = 'active')`.mapWith(Number),
      disabled: sql<number>`count(*) FILTER (WHERE ${places.status} = 'disabled')`.mapWith(Number),
      merged: sql<number>`count(*) FILTER (WHERE ${places.status} = 'merged')`.mapWith(Number),
    }).from(places),
    db.select({ value: sql<number>`count(*)`.mapWith(Number) }).from(observations).where(and(
      eq(observations.moderationStatus, 'approved'),
      sql`${observations.withdrawnAt} IS NULL`,
    )),
  ]);
  return {
    items,
    total: total?.value ?? 0,
    page: input.page,
    pageSize: input.pageSize,
    summary: {
      active: summary?.active ?? 0,
      disabled: summary?.disabled ?? 0,
      merged: summary?.merged ?? 0,
      evidence: evidence?.value ?? 0,
    },
  };
}

export async function listAdminPlaceTargets(input: { query?: string; excludePlaceId?: string }) {
  const search = input.query ? `%${input.query}%` : undefined;
  return db.select({
    id: places.id,
    name: places.name,
    address: places.address,
    updatedAt: places.updatedAt,
  }).from(places).where(and(
    eq(places.status, 'active'),
    input.excludePlaceId ? ne(places.id, input.excludePlaceId) : undefined,
    search ? or(ilike(places.name, search), ilike(places.address, search), ilike(places.externalId, search)) : undefined,
  )).orderBy(desc(places.updatedAt), desc(places.id)).limit(50);
}

export async function createAdminPlace(input: MutationContext & PlaceFields) {
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(places).values({
      name: input.name,
      categoryCode: input.categoryCode,
      longitude: String(input.longitude),
      latitude: String(input.latitude),
      location: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)`,
      address: input.address ?? null,
      provinceCode: '360000',
      status: 'active',
      adminOverrideAt: new Date(),
    }).returning();
    if (!created) throw new Error('PLACE_CREATE_FAILED');
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: 'place.created', targetType: 'place', targetId: created.id,
      reason: input.reason, metadata: { after: placeAuditView(created) }, requestId: input.requestId,
    });
    return created;
  });
}

export async function updateAdminPlace(input: MutationContext & PlaceFields & { placeId: string; expectedUpdatedAt: Date }): Promise<PlaceMutationResult<{ id: string; updatedAt: Date }>> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(places).where(eq(places.id, input.placeId)).for('update').limit(1);
    if (!existing) return failure('PLACE_NOT_FOUND', '地点不存在');
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) return failure('PLACE_CONFLICT', '地点已被其他管理员更新，请刷新后重试');
    if (existing.status === 'merged') return failure('PLACE_MERGED_READ_ONLY', '已合并地点不可直接编辑，请编辑 canonical 地点');
    const now = new Date();
    const [updated] = await tx.update(places).set({
      name: input.name,
      categoryCode: input.categoryCode,
      longitude: String(input.longitude),
      latitude: String(input.latitude),
      location: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)`,
      address: input.address ?? null,
      adminOverrideAt: now,
      updatedAt: now,
    }).where(eq(places.id, existing.id)).returning();
    if (!updated) throw new Error('PLACE_UPDATE_FAILED');
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: 'place.updated', targetType: 'place', targetId: existing.id,
      reason: input.reason, metadata: { before: placeAuditView(existing), after: placeAuditView(updated) }, requestId: input.requestId,
    });
    return { ok: true, value: { id: updated.id, updatedAt: updated.updatedAt } };
  });
}

export async function setAdminPlaceStatus(input: MutationContext & { placeId: string; status: Exclude<PlaceStatus, 'merged'>; expectedUpdatedAt: Date }): Promise<PlaceMutationResult<{ id: string; status: string; updatedAt: Date }>> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(places).where(eq(places.id, input.placeId)).for('update').limit(1);
    if (!existing) return failure('PLACE_NOT_FOUND', '地点不存在');
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) return failure('PLACE_CONFLICT', '地点已被其他管理员更新，请刷新后重试');
    if (existing.status === 'merged') return failure('PLACE_MERGED_READ_ONLY', '已合并地点不能变更状态');
    if (input.status === 'disabled') {
      const incoming = await tx.select({ id: places.id }).from(places).where(eq(places.mergedIntoPlaceId, existing.id)).limit(1);
      if (incoming.length > 0) return failure('PLACE_CANONICAL_TARGET_REQUIRED', '该地点是其他记录的 canonical 目标，不能停用');
    }
    if (existing.status === input.status) return { ok: true, value: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt } };
    const now = new Date();
    const [updated] = await tx.update(places).set({ status: input.status, updatedAt: now }).where(eq(places.id, existing.id)).returning();
    if (!updated) throw new Error('PLACE_STATUS_UPDATE_FAILED');
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: input.status === 'disabled' ? 'place.disabled' : 'place.activated',
      targetType: 'place', targetId: existing.id, reason: input.reason,
      metadata: { before_status: existing.status, after_status: updated.status }, requestId: input.requestId,
    });
    return { ok: true, value: { id: updated.id, status: updated.status, updatedAt: updated.updatedAt } };
  });
}

export async function mergeAdminPlace(input: MutationContext & { sourcePlaceId: string; targetPlaceId: string; expectedSourceUpdatedAt: Date; expectedTargetUpdatedAt: Date }): Promise<PlaceMutationResult<{ sourceId: string; targetId: string; mergedAt: Date }>> {
  if (input.sourcePlaceId === input.targetPlaceId) return failure('PLACE_MERGE_SELF', '地点不能合并到自身');
  return withPlaceTransactionRetry(async (tx) => {
    const locked = await tx.select().from(places)
      .where(inArray(places.id, [input.sourcePlaceId, input.targetPlaceId]))
      .orderBy(asc(places.id)).for('update');
    const source = locked.find((place) => place.id === input.sourcePlaceId);
    const target = locked.find((place) => place.id === input.targetPlaceId);
    if (!source || !target) return failure('PLACE_NOT_FOUND', '来源地点或目标地点不存在');
    if (source.updatedAt.getTime() !== input.expectedSourceUpdatedAt.getTime() || target.updatedAt.getTime() !== input.expectedTargetUpdatedAt.getTime()) {
      return failure('PLACE_CONFLICT', '来源地点或目标地点已更新，请刷新后重试');
    }
    if (source.status === 'merged') return failure('PLACE_MERGED_READ_ONLY', '来源地点已经合并');
    if (target.status !== 'active') return failure('PLACE_MERGE_TARGET_INVALID', '目标地点必须处于启用状态');
    const now = new Date();
    // 与社区投票保持 task -> proof -> observation 的锁顺序，避免地点合并和投票互相等待。
    await tx.update(communityReviewTasks).set({ placeId: target.id, updatedAt: now }).where(eq(communityReviewTasks.placeId, source.id));
    await tx.update(locationProofs).set({ placeId: target.id }).where(eq(locationProofs.placeId, source.id));
    await tx.update(observations).set({ placeId: target.id, updatedAt: now }).where(eq(observations.placeId, source.id));
    await tx.update(placeUnits).set({ placeId: target.id, updatedAt: now }).where(eq(placeUnits.placeId, source.id));
    await tx.update(facilities).set({ placeId: target.id, updatedAt: now }).where(eq(facilities.placeId, source.id));
    await tx.update(verificationRecords).set({ placeId: target.id, updatedAt: now }).where(eq(verificationRecords.placeId, source.id));
    const redirectedAliases = await tx.update(places).set({ mergedIntoPlaceId: target.id, updatedAt: now })
      .where(and(eq(places.mergedIntoPlaceId, source.id), eq(places.status, 'merged')))
      .returning({ id: places.id });
    await tx.update(places).set({ status: 'merged', mergedIntoPlaceId: target.id, updatedAt: now }).where(eq(places.id, source.id));
    await tx.update(places).set({ updatedAt: now }).where(eq(places.id, target.id));
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: 'place.merged', targetType: 'place', targetId: source.id,
      reason: input.reason, metadata: { source: placeAuditView(source), canonical_target_id: target.id, canonical_target_name: target.name, redirected_alias_count: redirectedAliases.length }, requestId: input.requestId,
    });
    return { ok: true, value: { sourceId: source.id, targetId: target.id, mergedAt: now } };
  });
}

function failure(code: string, message: string) {
  return { ok: false as const, code, message };
}

async function withPlaceTransactionRetry<T>(operation: (tx: PlaceTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.transaction(operation);
    } catch (error: unknown) {
      if (!isRetryableTransactionError(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25 + Math.floor(Math.random() * 25)));
    }
  }
  throw new Error('PLACE_TRANSACTION_RETRY_EXHAUSTED');
}

function isRetryableTransactionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === '40P01' || error.code === '40001');
}

function placeAuditView(place: typeof places.$inferSelect) {
  return {
    name: place.name,
    category_code: place.categoryCode,
    longitude: place.longitude,
    latitude: place.latitude,
    address: place.address,
    status: place.status,
    merged_into_place_id: place.mergedIntoPlaceId,
    admin_override_at: place.adminOverrideAt?.toISOString() ?? null,
    updated_at: place.updatedAt.toISOString(),
  };
}
