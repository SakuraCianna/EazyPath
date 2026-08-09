import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';

const WINDOW_MS = 60_000;
const INSTALLATION_MAX_SUBMISSIONS = 12;
const SOURCE_MAX_SUBMISSIONS = 60;
const SOURCE_DISTINCT_INSTALLATION_THRESHOLD = 20;
const GLOBAL_MAX_SUBMISSIONS = 1_000;
const LOCATION_PROOF_INSTALLATION_MAX = 10;
const LOCATION_PROOF_SOURCE_MAX = 60;
const LOCATION_PROOF_GLOBAL_MAX = 1_000;

const consumeScript = `
local installationCount = redis.call('INCR', KEYS[1])
if installationCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if installationCount > tonumber(ARGV[2]) then
  return {0, math.max(redis.call('PTTL', KEYS[1]), 1000), 0}
end
local sourceCount = redis.call('INCR', KEYS[2])
redis.call('SADD', KEYS[3], ARGV[5])
if sourceCount == 1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
  redis.call('PEXPIRE', KEYS[3], ARGV[1])
end
if sourceCount > tonumber(ARGV[3]) then
  return {0, math.max(redis.call('PTTL', KEYS[2]), 1000), 0}
end
local globalCount = redis.call('INCR', KEYS[4])
if globalCount == 1 then redis.call('PEXPIRE', KEYS[4], ARGV[1]) end
if globalCount > tonumber(ARGV[4]) then
  return {0, math.max(redis.call('PTTL', KEYS[4]), 1000), 0}
end
local suspiciousSource = redis.call('SCARD', KEYS[3]) > tonumber(ARGV[6]) and 1 or 0
return {1, 0, suspiciousSource}
`;

const consumeLocationProofScript = `
local installationCount = redis.call('INCR', KEYS[1])
if installationCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if installationCount > tonumber(ARGV[2]) then
  return {0, math.max(redis.call('PTTL', KEYS[1]), 1000)}
end
local sourceCount = redis.call('INCR', KEYS[2])
if sourceCount == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
if sourceCount > tonumber(ARGV[3]) then
  return {0, math.max(redis.call('PTTL', KEYS[2]), 1000)}
end
local globalCount = redis.call('INCR', KEYS[3])
if globalCount == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[1]) end
if globalCount > tonumber(ARGV[4]) then
  return {0, math.max(redis.call('PTTL', KEYS[3]), 1000)}
end
return {1, 0}
`;

export interface CommunityReviewPermit {
  allowed: boolean;
  retryAfterSeconds: number;
  suspiciousSource: boolean;
}

export class CommunityReviewProtectionUnavailableError extends Error {
  constructor() {
    super('社区复核保护服务不可用');
    this.name = 'CommunityReviewProtectionUnavailableError';
  }
}

let guardClient: Redis | undefined;

export function fingerprintCommunityReviewSource(input: {
  trustProxy: boolean;
  realIp?: string;
  forwardedFor?: string;
}, secret: string): string {
  const forwardedIp = input.forwardedFor?.split(',')[0]?.trim();
  const source = input.trustProxy ? input.realIp?.trim() || forwardedIp || 'proxy-unknown' : 'direct';
  return createHmac('sha256', secret).update(`community-review:${source.slice(0, 128)}`).digest('hex');
}

export async function consumeCommunityReviewPermit(installationId: string, sourceFingerprint: string): Promise<CommunityReviewPermit> {
  try {
    const result = await getGuardClient().eval(
      consumeScript,
      4,
      `eazypath:community-review:installation:${installationId}`,
      `eazypath:community-review:source:${sourceFingerprint}`,
      `eazypath:community-review:source-installations:${sourceFingerprint}`,
      'eazypath:community-review:global',
      WINDOW_MS,
      INSTALLATION_MAX_SUBMISSIONS,
      SOURCE_MAX_SUBMISSIONS,
      GLOBAL_MAX_SUBMISSIONS,
      installationId,
      SOURCE_DISTINCT_INSTALLATION_THRESHOLD,
    );
    if (!Array.isArray(result) || result.length < 3) throw new Error('INVALID_GUARD_RESULT');
    const allowed = Number(result[0]) === 1;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Number(result[1]) / 1000)),
      suspiciousSource: allowed && Number(result[2]) === 1,
    };
  } catch {
    throw new CommunityReviewProtectionUnavailableError();
  }
}

export async function consumeLocationProofPermit(installationId: string, sourceFingerprint: string): Promise<CommunityReviewPermit> {
  try {
    const result = await getGuardClient().eval(
      consumeLocationProofScript,
      3,
      `eazypath:location-proof:installation:${installationId}`,
      `eazypath:location-proof:source:${sourceFingerprint}`,
      'eazypath:location-proof:global',
      WINDOW_MS,
      LOCATION_PROOF_INSTALLATION_MAX,
      LOCATION_PROOF_SOURCE_MAX,
      LOCATION_PROOF_GLOBAL_MAX,
    );
    if (!Array.isArray(result) || result.length < 2) throw new Error('INVALID_GUARD_RESULT');
    const allowed = Number(result[0]) === 1;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Number(result[1]) / 1000)),
      suspiciousSource: false,
    };
  } catch {
    throw new CommunityReviewProtectionUnavailableError();
  }
}

export async function closeCommunityReviewGuard(): Promise<void> {
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
