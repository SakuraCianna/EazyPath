import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';

const WINDOW_MS = 60_000;
const INSTALLATION_MAX_OPENS = 30;
const GLOBAL_MAX_OPENS = 5_000;
const INSTALLATION_MAX_CONCURRENT = 3;
const GLOBAL_MAX_CONCURRENT = 200;
const LEASE_MS = 120_000;

const acquireScript = `
local installationOpenCount = redis.call('INCR', KEYS[1])
if installationOpenCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if installationOpenCount > tonumber(ARGV[2]) then
  return {0, math.max(redis.call('PTTL', KEYS[1]), 1000)}
end
local globalOpenCount = redis.call('INCR', KEYS[2])
if globalOpenCount == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
if globalOpenCount > tonumber(ARGV[3]) then
  return {0, math.max(redis.call('PTTL', KEYS[2]), 1000)}
end
local now = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[5]) or redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[6]) then
  return {0, 1000}
end
local expiresAt = now + tonumber(ARGV[7])
redis.call('ZADD', KEYS[3], expiresAt, ARGV[8])
redis.call('ZADD', KEYS[4], expiresAt, ARGV[8])
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[7]) * 2)
redis.call('PEXPIRE', KEYS[4], tonumber(ARGV[7]) * 2)
return {1, 0}
`;

const refreshScript = `
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) or not redis.call('ZSCORE', KEYS[2], ARGV[3]) then
  return 0
end
local expiresAt = tonumber(ARGV[1]) + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], expiresAt, ARGV[3])
redis.call('ZADD', KEYS[2], expiresAt, ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
return 1
`;

const releaseScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export interface TaskEventStreamPermit {
  allowed: boolean;
  retryAfterSeconds: number;
  refresh: () => Promise<void>;
  release: () => Promise<void>;
}

export class TaskEventStreamProtectionUnavailableError extends Error {
  constructor() {
    super('任务事件流保护服务不可用');
    this.name = 'TaskEventStreamProtectionUnavailableError';
  }
}

let guardClient: Redis | undefined;

export async function acquireTaskEventStreamPermit(installationId: string): Promise<TaskEventStreamPermit> {
  const token = randomUUID();
  const installationActiveKey = `eazypath:task-events:active:installation:${installationId}`;
  const globalActiveKey = 'eazypath:task-events:active:global';
  try {
    const result = await getGuardClient().eval(
      acquireScript,
      4,
      `eazypath:task-events:opens:installation:${installationId}`,
      'eazypath:task-events:opens:global',
      installationActiveKey,
      globalActiveKey,
      WINDOW_MS,
      INSTALLATION_MAX_OPENS,
      GLOBAL_MAX_OPENS,
      Date.now(),
      INSTALLATION_MAX_CONCURRENT,
      GLOBAL_MAX_CONCURRENT,
      LEASE_MS,
      token,
    );
    if (!Array.isArray(result) || result.length < 2) throw new Error('INVALID_GUARD_RESULT');
    const allowed = Number(result[0]) === 1;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Number(result[1]) / 1_000)),
      refresh: allowed
        ? async () => {
          const refreshed = await getGuardClient().eval(
            refreshScript,
            2,
            installationActiveKey,
            globalActiveKey,
            Date.now(),
            LEASE_MS,
            token,
          );
          if (Number(refreshed) !== 1) throw new TaskEventStreamProtectionUnavailableError();
        }
        : async () => undefined,
      release: allowed
        ? async () => {
          await getGuardClient().eval(releaseScript, 2, installationActiveKey, globalActiveKey, token);
        }
        : async () => undefined,
    };
  } catch (error) {
    if (error instanceof TaskEventStreamProtectionUnavailableError) throw error;
    throw new TaskEventStreamProtectionUnavailableError();
  }
}

export async function closeTaskEventStreamGuard(): Promise<void> {
  const client = guardClient;
  guardClient = undefined;
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
}

function getGuardClient(): Redis {
  if (guardClient) return guardClient;
  guardClient = new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempts) => Math.min(Math.max(attempts * 500, 1_000), 20_000),
  });
  guardClient.on('error', () => undefined);
  return guardClient;
}
