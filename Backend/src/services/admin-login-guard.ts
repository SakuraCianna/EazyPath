import { createHmac, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';

const WINDOW_MS = 60_000;
const SOURCE_MAX_ATTEMPTS = 10;
const GLOBAL_MAX_ATTEMPTS = 100;
const MAX_CONCURRENT_CHECKS = 2;
const LEASE_MS = 60_000;

const acquireScript = `
local sourceCount = redis.call('INCR', KEYS[1])
if sourceCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if sourceCount > tonumber(ARGV[2]) then
  local retryMs = math.max(redis.call('PTTL', KEYS[1]), 1000)
  return {0, retryMs, 1}
end
local globalCount = redis.call('INCR', KEYS[2])
if globalCount == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
if globalCount > tonumber(ARGV[3]) then
  local retryMs = math.max(redis.call('PTTL', KEYS[2]), 1000)
  return {0, retryMs, 1}
end
local now = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[5]) then
  return {0, tonumber(ARGV[6]), 2}
end
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[6]), ARGV[7])
redis.call('PEXPIRE', KEYS[3], ARGV[6])
return {1, 0, 0}
`;

const releaseScript = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

export interface AdminLoginPermit {
  allowed: boolean;
  retryAfterSeconds: number;
  release: () => Promise<void>;
}

export class AdminLoginProtectionUnavailableError extends Error {
  constructor() {
    super('管理员登录保护服务不可用');
    this.name = 'AdminLoginProtectionUnavailableError';
  }
}

let loginGuardClient: Redis | undefined;

export function fingerprintAdminLoginSource(input: {
  trustProxy: boolean;
  realIp?: string;
  forwardedFor?: string;
}, secret: string): string {
  const forwardedIp = input.forwardedFor?.split(',')[0]?.trim();
  const source = input.trustProxy ? input.realIp?.trim() || forwardedIp || 'proxy-unknown' : 'direct';
  return createHmac('sha256', secret).update(source.slice(0, 128)).digest('hex');
}

export async function acquireAdminLoginPermit(sourceFingerprint: string): Promise<AdminLoginPermit> {
  const token = randomUUID();
  const now = Date.now();
  try {
    const result = await getLoginGuardClient().eval(
      acquireScript,
      3,
      `eazypath:admin-login:source:${sourceFingerprint}`,
      'eazypath:admin-login:global',
      'eazypath:admin-login:active',
      WINDOW_MS,
      SOURCE_MAX_ATTEMPTS,
      GLOBAL_MAX_ATTEMPTS,
      now,
      MAX_CONCURRENT_CHECKS,
      LEASE_MS,
      token,
    );
    if (!Array.isArray(result) || result.length < 3) throw new Error('INVALID_GUARD_RESULT');
    const allowed = Number(result[0]) === 1;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(Number(result[1]) / 1000));
    return {
      allowed,
      retryAfterSeconds,
      release: allowed
        ? async () => {
          await getLoginGuardClient().eval(releaseScript, 1, 'eazypath:admin-login:active', token);
        }
        : async () => undefined,
    };
  } catch {
    throw new AdminLoginProtectionUnavailableError();
  }
}

export async function closeAdminLoginGuard(): Promise<void> {
  const client = loginGuardClient;
  loginGuardClient = undefined;
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
}

function getLoginGuardClient(): Redis {
  if (loginGuardClient) return loginGuardClient;
  loginGuardClient = new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempts) => Math.min(Math.max(attempts * 500, 1_000), 20_000),
  });
  loginGuardClient.on('error', () => undefined);
  return loginGuardClient;
}
