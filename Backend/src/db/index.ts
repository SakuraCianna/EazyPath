import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '../config/env.js';
import * as schema from './schema.js';

const env = getEnv();

export const queryClient = postgres(env.DATABASE_URL, {
  max: 12,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => undefined,
});

export const db = drizzle(queryClient, { schema });

export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = performance.now();
  try {
    await queryClient`select 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - startedAt) };
  }
}

export * from './schema.js';
