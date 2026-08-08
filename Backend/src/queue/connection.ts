import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from '../config/env.js';

export function redisConnectionOptions(worker: boolean): RedisOptions {
  const url = new URL(getEnv().REDIS_URL);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  const options: RedisOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number.isFinite(database) ? database : 0,
    maxRetriesPerRequest: worker ? null : 1,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempts) => Math.min(Math.max(attempts * 500, 1_000), 20_000),
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.protocol === 'rediss:') options.tls = {};
  return options;
}

export async function checkRedis(): Promise<{ ok: boolean; latencyMs: number }> {
  // ioredis 6 的 URL 构造签名可保留 rediss、用户名、密码和 db，同时规避其严格可选类型声明冲突。
  const client = new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempts) => Math.min(Math.max(attempts * 500, 1_000), 20_000),
  });
  const startedAt = performance.now();
  try {
    await client.ping();
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    await client.quit().catch(() => undefined);
  }
}
