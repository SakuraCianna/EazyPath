import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createUserSession, revokeUserSessions, rotateUserSession } from '../auth/tokens.js';
import {
  db,
  installationAccounts,
  installationChallenges,
  userProfiles,
} from '../db/index.js';
import { constantTimeEquals, randomToken, sha256 } from '../lib/crypto.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import type { AppBindings } from '../types.js';

const challengeSchema = z.object({
  installation_guid: z.uuid(),
  purpose: z.enum(['register', 'recover', 'sensitive_action']).default('register'),
});

const registerSchema = z.object({
  challenge_id: z.uuid(),
  challenge: z.string().min(32).max(256),
  installation_guid: z.uuid(),
  public_key_spki: z.string().min(64).max(2048),
  signature: z.string().min(64).max(2048),
});

const refreshSchema = z.object({ refresh_token: z.string().min(32).max(512) });

export const installationsRouter = new Hono<AppBindings>();
export const sessionsRouter = new Hono<AppBindings>();

installationsRouter.post('/challenges', async (c) => {
  const parsed = challengeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'INVALID_INPUT', '安装实例挑战参数无效');

  const challenge = randomToken(48);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const [record] = await db
    .insert(installationChallenges)
    .values({
      installationGuid: parsed.data.installation_guid,
      purpose: parsed.data.purpose,
      challengeHash: sha256(challenge),
      expiresAt,
    })
    .returning({ id: installationChallenges.id });
  if (!record) return fail(c, 500, 'CHALLENGE_CREATE_FAILED', '暂时无法创建安装挑战', { retryable: true });

  return ok(c, {
    challenge_id: record.id,
    challenge,
    expires_at: expiresAt.toISOString(),
    signing_payload: signingPayload(record.id, parsed.data.installation_guid, challenge),
  });
});

installationsRouter.post('/register', async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return registrationFailure(c);
  const input = parsed.data;
  const now = new Date();
  const [challenge] = await db.select().from(installationChallenges).where(and(
    eq(installationChallenges.id, input.challenge_id),
    eq(installationChallenges.installationGuid, input.installation_guid),
    eq(installationChallenges.purpose, 'register'),
    gt(installationChallenges.expiresAt, now),
    isNull(installationChallenges.consumedAt),
  )).limit(1);
  if (!challenge) return registrationFailure(c);
  if (!constantTimeEquals(challenge.challengeHash, sha256(input.challenge))) {
    return registrationFailure(c);
  }
  if (!verifyInstallationSignature(input)) return registrationFailure(c);

  const [consumed] = await db.update(installationChallenges).set({ consumedAt: now }).where(and(
    eq(installationChallenges.id, challenge.id),
    isNull(installationChallenges.consumedAt),
  )).returning({ id: installationChallenges.id });
  if (!consumed) return registrationFailure(c);

  const account = await db.transaction(async (tx) => {
    let [current] = await tx.select().from(installationAccounts).where(eq(
      installationAccounts.installationGuid,
      input.installation_guid,
    )).limit(1);
    if (current && current.publicKeySpki !== input.public_key_spki) return null;
    if (!current) {
      [current] = await tx.insert(installationAccounts)
      .values({
        installationGuid: input.installation_guid,
        publicKeySpki: input.public_key_spki,
      })
      .onConflictDoNothing()
      .returning();
      if (!current) {
        [current] = await tx.select().from(installationAccounts).where(eq(
          installationAccounts.installationGuid,
          input.installation_guid,
        )).limit(1);
      }
    }
    if (!current || current.publicKeySpki !== input.public_key_spki) return null;
    await tx.insert(userProfiles).values({
      installationId: current.id,
      mobility: {
        mobilityMode: 'wheelchair_manual',
        requireStepFree: true,
        minimumDoorWidthCm: 80,
        maximumObstacleHeightCm: 2,
        requireAccessibleRestroom: true,
        requireRollInShower: false,
        avoidUnverifiedSegments: true,
      },
      interaction: {
        largeText: true,
        highContrast: false,
        preferVoiceInput: true,
        preferVoiceOutput: true,
        hapticFeedback: true,
      },
    }).onConflictDoNothing({ target: userProfiles.installationId });
    await tx.update(installationAccounts)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(installationAccounts.id, current.id));
    return current;
  });
  if (!account) return registrationFailure(c);

  return ok(c, {
    installation_id: account.id,
    ...(await createUserSession(account.id)),
  }, '安装账户已就绪');
});

sessionsRouter.post('/refresh', async (c) => {
  const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 401, 'REFRESH_TOKEN_INVALID', '刷新令牌无效');
  const session = await rotateUserSession(parsed.data.refresh_token);
  if (!session) return fail(c, 401, 'REFRESH_TOKEN_INVALID', '刷新令牌无效或已撤销');
  return ok(c, session);
});

sessionsRouter.post('/revoke', requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { refresh_token?: string; all?: boolean };
  await revokeUserSessions(c.get('installationId'), body.all ? undefined : body.refresh_token);
  return ok(c, { revoked: true });
});

function verifyInstallationSignature(input: z.infer<typeof registerSchema>): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(input.public_key_spki, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(
      'sha256',
      Buffer.from(signingPayload(input.challenge_id, input.installation_guid, input.challenge)),
      publicKey,
      Buffer.from(input.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

function signingPayload(challengeId: string, installationGuid: string, challenge: string): string {
  return `EazyPath:v1:${challengeId}:${installationGuid}:${challenge}`;
}

function registrationFailure(c: Parameters<typeof fail>[0]) {
  return fail(c, 401, 'INSTALLATION_PROOF_INVALID', '安装实例证明无效或已过期', { retryable: true });
}
