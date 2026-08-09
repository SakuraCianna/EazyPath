import { and, eq } from 'drizzle-orm';
import { db, places } from '../db/index.js';

export interface ActivePlaceReference {
  id: string;
  latitude: string;
  longitude: string;
}

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function resolveActivePlace(placeId: string): Promise<ActivePlaceReference | undefined> {
  const [requested] = await db.select({
    id: places.id,
    latitude: places.latitude,
    longitude: places.longitude,
    status: places.status,
    mergedIntoPlaceId: places.mergedIntoPlaceId,
  }).from(places).where(eq(places.id, placeId)).limit(1);
  if (!requested) return undefined;
  if (requested.status === 'active') return requested;
  if (requested.status !== 'merged' || !requested.mergedIntoPlaceId) return undefined;
  return (await db.select({
    id: places.id,
    latitude: places.latitude,
    longitude: places.longitude,
  }).from(places).where(and(
    eq(places.id, requested.mergedIntoPlaceId),
    eq(places.status, 'active'),
  )).limit(1))[0];
}

/**
 * Locks only the already-resolved canonical row. It deliberately does not chase
 * a new merge target while holding this lock, avoiding a source -> target lock
 * order that could deadlock with the administrator merge transaction.
 */
export async function lockCanonicalPlace(
  tx: DatabaseTransaction,
  canonicalPlaceId: string,
): Promise<ActivePlaceReference | undefined> {
  return (await tx.select({
    id: places.id,
    latitude: places.latitude,
    longitude: places.longitude,
  }).from(places).where(and(
    eq(places.id, canonicalPlaceId),
    eq(places.status, 'active'),
  )).for('update').limit(1))[0];
}

export async function lockCanonicalPlaceForRead(
  tx: DatabaseTransaction,
  canonicalPlaceId: string,
): Promise<ActivePlaceReference | undefined> {
  return (await tx.select({
    id: places.id,
    latitude: places.latitude,
    longitude: places.longitude,
  }).from(places).where(and(
    eq(places.id, canonicalPlaceId),
    eq(places.status, 'active'),
  )).for('share').limit(1))[0];
}
