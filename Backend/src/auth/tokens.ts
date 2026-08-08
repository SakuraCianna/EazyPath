import { and, eq, gt, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../config/env.js';
import { db, installationAccounts, refreshSessions } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';

const ACCESS_TOKEN_SECONDS = 15 * 60;
const REFRESH_TOKEN_DAYS = 30;

export interface UserSessionTokens {
  access_token: string;
  access_token_expires_in: number;
  refresh_token: string;
  refresh_token_expires_at: string;
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().AUTH_TOKEN_SECRET);
}

export async function createUserSession(installationId: string): Promise<UserSessionTokens | null> {
  const refreshToken = randomToken(48);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  const created = await db.transaction(async (tx) => {
    const [account] = await tx.select({ status: installationAccounts.status })
      .from(installationAccounts)
      .where(eq(installationAccounts.id, installationId))
      .for('update')
      .limit(1);
    if (account?.status !== 'active') return false;
    await tx.insert(refreshSessions).values({
      installationId,
      tokenHash: sha256(refreshToken),
      expiresAt: refreshExpiresAt,
    });
    return true;
  });
  if (!created) return null;

  return {
    access_token: await createAccessToken(installationId),
    access_token_expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    refresh_token_expires_at: refreshExpiresAt.toISOString(),
  };
}

export async function rotateUserSession(refreshToken: string): Promise<UserSessionTokens | null> {
  const now = new Date();
  const tokenHash = sha256(refreshToken);
  const rotated = await db.transaction(async (tx) => {
    const [candidate] = await tx.select({ installationId: refreshSessions.installationId })
      .from(refreshSessions)
      .where(and(
        eq(refreshSessions.tokenHash, tokenHash),
        isNull(refreshSessions.revokedAt),
        gt(refreshSessions.expiresAt, now),
      ))
      .limit(1);
    if (!candidate) return null;
    const [account] = await tx.select({ status: installationAccounts.status })
      .from(installationAccounts)
      .where(eq(installationAccounts.id, candidate.installationId))
      .for('update')
      .limit(1);
    if (account?.status !== 'active') return null;
    const [consumed] = await tx.update(refreshSessions).set({ revokedAt: now }).where(and(
      eq(refreshSessions.tokenHash, tokenHash),
      isNull(refreshSessions.revokedAt),
      gt(refreshSessions.expiresAt, now),
    )).returning();
    if (!consumed) return null;
    const nextRefreshToken = randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    const [replacement] = await tx.insert(refreshSessions).values({
      installationId: consumed.installationId,
      tokenHash: sha256(nextRefreshToken),
      expiresAt: refreshExpiresAt,
    }).returning({ id: refreshSessions.id });
    if (!replacement) throw new Error('REFRESH_SESSION_CREATE_FAILED');
    await tx.update(refreshSessions).set({ replacedById: replacement.id }).where(eq(refreshSessions.id, consumed.id));
    return { installationId: consumed.installationId, nextRefreshToken, refreshExpiresAt };
  });
  if (!rotated) {
    const [replayed] = await db.select().from(refreshSessions).where(eq(refreshSessions.tokenHash, tokenHash)).limit(1);
    if (replayed?.replacedById) await revokeUserSessions(replayed.installationId);
    return null;
  }
  return {
    access_token: await createAccessToken(rotated.installationId),
    access_token_expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: rotated.nextRefreshToken,
    refresh_token_expires_at: rotated.refreshExpiresAt.toISOString(),
  };
}

export async function revokeUserSessions(installationId: string, refreshToken?: string): Promise<void> {
  const condition = refreshToken
    ? and(
        eq(refreshSessions.installationId, installationId),
        eq(refreshSessions.tokenHash, sha256(refreshToken)),
        isNull(refreshSessions.revokedAt),
      )
    : and(eq(refreshSessions.installationId, installationId), isNull(refreshSessions.revokedAt));
  await db.update(refreshSessions).set({ revokedAt: new Date() }).where(condition);
}

export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: 'eazypath-api',
      audience: 'eazypath-android',
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

async function createAccessToken(installationId: string): Promise<string> {
  return new SignJWT({ scope: 'user' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('eazypath-api')
    .setAudience('eazypath-android')
    .setSubject(installationId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_SECONDS}s`)
    .sign(signingKey());
}
