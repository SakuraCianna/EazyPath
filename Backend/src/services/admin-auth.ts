import argon2 from 'argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { adminTokenHash } from '../auth/admin.js';
import {
  ADMIN_SESSION_MAX_LIFETIME_MS,
  isAdminLoginFailureLocked,
  nextLoginFailureState,
  validateAdminPassword,
} from '../domain/admin-security.js';
import {
  adminRoles,
  adminSessions,
  adminUsers,
  auditEvents,
  db,
} from '../db/index.js';
import { randomToken } from '../lib/crypto.js';

const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;
const dummyPasswordHash = argon2.hash(randomToken(32), argonOptions);

export interface AdminLoginSuccess {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  identity: {
    id: string;
    username: string;
    roleCode: string;
    permissions: string[];
  };
}

export type AdminPasswordChangeResult =
  | { ok: true }
  | { ok: false; reason: 'CURRENT_PASSWORD_INVALID' | 'PASSWORD_POLICY_INVALID'; message?: string };

export async function loginAdmin(
  username: string,
  password: string,
  requestId: string,
  now = new Date(),
): Promise<AdminLoginSuccess | null> {
  const [candidate] = await db
    .select({
      id: adminUsers.id,
      username: adminUsers.username,
      passwordHash: adminUsers.passwordHash,
      status: adminUsers.status,
      lockedUntil: adminUsers.lockedUntil,
      roleCode: adminRoles.code,
      permissions: adminRoles.permissions,
    })
    .from(adminUsers)
    .innerJoin(adminRoles, eq(adminUsers.roleId, adminRoles.id))
    .where(eq(adminUsers.username, username))
    .limit(1);

  const passwordValid = await argon2.verify(candidate?.passwordHash ?? await dummyPasswordHash, password).catch(() => false);
  if (!candidate || candidate.status !== 'active') return null;
  if (!passwordValid) {
    if (isAdminLoginFailureLocked(false, candidate.lockedUntil, now)) return null;
    await db.transaction(async (tx) => {
      const [lockedUser] = await tx
        .select({
          id: adminUsers.id,
          failedLoginCount: adminUsers.failedLoginCount,
          lockedUntil: adminUsers.lockedUntil,
        })
        .from(adminUsers)
        .where(eq(adminUsers.id, candidate.id))
        .for('update')
        .limit(1);
      if (!lockedUser) return;
      if (isAdminLoginFailureLocked(false, lockedUser.lockedUntil, now)) return;
      const failure = nextLoginFailureState(lockedUser.failedLoginCount, lockedUser.lockedUntil, now);
      await tx.update(adminUsers).set({ ...failure, updatedAt: now }).where(eq(adminUsers.id, candidate.id));
      await tx.insert(auditEvents).values({
        actorType: 'admin',
        actorId: candidate.id,
        action: 'admin.login_failed',
        targetType: 'admin_user',
        targetId: candidate.id,
        metadata: { failed_login_count: failure.failedLoginCount, locked: failure.lockedUntil !== null },
        requestId,
      });
    });
    return null;
  }

  const sessionToken = randomToken(48);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_MAX_LIFETIME_MS);
  const created = await db.transaction(async (tx) => {
    const [lockedUser] = await tx
      .select({ status: adminUsers.status, passwordHash: adminUsers.passwordHash })
      .from(adminUsers)
      .where(eq(adminUsers.id, candidate.id))
      .for('update')
      .limit(1);
    if (!lockedUser || lockedUser.status !== 'active' || lockedUser.passwordHash !== candidate.passwordHash) {
      return false;
    }
    await tx.insert(adminSessions).values({
      adminUserId: candidate.id,
      tokenHash: adminTokenHash(sessionToken),
      csrfHash: adminTokenHash(csrfToken),
      expiresAt,
      lastSeenAt: now,
    });
    await tx.update(adminUsers).set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
      updatedAt: now,
    }).where(eq(adminUsers.id, candidate.id));
    await tx.insert(auditEvents).values({
      actorType: 'admin',
      actorId: candidate.id,
      action: 'admin.login',
      targetType: 'admin_user',
      targetId: candidate.id,
      requestId,
    });
    return true;
  });
  if (!created) return null;

  return {
    sessionToken,
    csrfToken,
    expiresAt,
    identity: {
      id: candidate.id,
      username: candidate.username,
      roleCode: candidate.roleCode,
      permissions: candidate.permissions,
    },
  };
}

export async function rotateAdminCsrf(sessionId: string, now = new Date()): Promise<string | null> {
  const csrfToken = randomToken(32);
  const [session] = await db.update(adminSessions).set({
    csrfHash: adminTokenHash(csrfToken),
    lastSeenAt: now,
  }).where(and(
    eq(adminSessions.id, sessionId),
    isNull(adminSessions.revokedAt),
    gt(adminSessions.expiresAt, now),
  )).returning({ id: adminSessions.id });
  return session ? csrfToken : null;
}

export async function revokeAdminSessions(
  actorId: string,
  sessionId: string,
  allSessions: boolean,
  requestId: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(adminSessions).set({ revokedAt: now }).where(and(
      allSessions ? eq(adminSessions.adminUserId, actorId) : eq(adminSessions.id, sessionId),
      isNull(adminSessions.revokedAt),
    ));
    await tx.insert(auditEvents).values({
      actorType: 'admin',
      actorId,
      action: allSessions ? 'admin.logout_all' : 'admin.logout',
      targetType: 'admin_user',
      targetId: actorId,
      requestId,
    });
  });
}

export async function changeAdminPassword(
  actorId: string,
  currentPassword: string,
  newPassword: string,
  requestId: string,
  now = new Date(),
): Promise<AdminPasswordChangeResult> {
  const [user] = await db.select({
    username: adminUsers.username,
    passwordHash: adminUsers.passwordHash,
  }).from(adminUsers).where(eq(adminUsers.id, actorId)).limit(1);
  if (!user || !(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))) {
    return { ok: false, reason: 'CURRENT_PASSWORD_INVALID' };
  }
  const policyIssue = validateAdminPassword(newPassword, user.username);
  if (policyIssue) return { ok: false, reason: 'PASSWORD_POLICY_INVALID', message: policyIssue };
  if (await argon2.verify(user.passwordHash, newPassword).catch(() => false)) {
    return { ok: false, reason: 'PASSWORD_POLICY_INVALID', message: '新密码不能与当前密码相同' };
  }

  const passwordHash = await argon2.hash(newPassword, argonOptions);
  return db.transaction(async (tx) => {
    const [lockedUser] = await tx
      .select({ passwordHash: adminUsers.passwordHash })
      .from(adminUsers)
      .where(eq(adminUsers.id, actorId))
      .for('update')
      .limit(1);
    if (!lockedUser || lockedUser.passwordHash !== user.passwordHash) {
      return { ok: false, reason: 'CURRENT_PASSWORD_INVALID' } as const;
    }
    await tx.update(adminUsers).set({ passwordHash, updatedAt: now }).where(eq(adminUsers.id, actorId));
    await tx.update(adminSessions).set({ revokedAt: now }).where(and(
      eq(adminSessions.adminUserId, actorId),
      isNull(adminSessions.revokedAt),
    ));
    await tx.insert(auditEvents).values({
      actorType: 'admin',
      actorId,
      action: 'admin.password_changed',
      targetType: 'admin_user',
      targetId: actorId,
      requestId,
    });
    return { ok: true } as const;
  });
}
