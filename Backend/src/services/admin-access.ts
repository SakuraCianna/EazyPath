import argon2 from 'argon2';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  validateAdminGrant,
  validateAdminPassword,
  validateAdminPermissions,
  validateAdminRoleMutation,
} from '../domain/admin-security.js';
import { adminRoles, adminSessions, adminUsers, auditEvents, db } from '../db/index.js';

const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

type AccessFailureCode =
  | 'ADMIN_SELF_ACCESS_CHANGE_FORBIDDEN'
  | 'ADMIN_USER_NOT_FOUND'
  | 'ADMIN_USERNAME_EXISTS'
  | 'ADMIN_ROLE_NOT_FOUND'
  | 'ADMIN_ROLE_EXISTS'
  | 'ADMIN_SUPER_ROLE_IMMUTABLE'
  | 'ADMIN_LAST_SUPER_ADMIN_REQUIRED'
  | 'ADMIN_GRANT_FORBIDDEN'
  | 'ADMIN_PASSWORD_POLICY_INVALID'
  | 'ADMIN_PERMISSION_INVALID';

export type AccessResult<T> = { ok: true; value: T } | { ok: false; code: AccessFailureCode; message: string };

type AdminTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createAdminUser(input: {
  actorId: string;
  username: string;
  password: string;
  roleId: string;
  reason: string;
  requestId: string;
}): Promise<AccessResult<{ id: string; username: string }>> {
  const passwordIssue = validateAdminPassword(input.password, input.username);
  if (passwordIssue) return failure('ADMIN_PASSWORD_POLICY_INVALID', passwordIssue);
  const passwordHash = await argon2.hash(input.password, argonOptions);

  try {
    return await withAdminTransactionRetry(async (tx) => {
      const actor = await loadGrantActor(tx, input.actorId);
      if (!actor) return failure('ADMIN_GRANT_FORBIDDEN', '当前管理员无权执行授权操作');
      const [role] = await tx.select({
        id: adminRoles.id,
        code: adminRoles.code,
        permissions: adminRoles.permissions,
      }).from(adminRoles).where(eq(adminRoles.id, input.roleId)).for('update').limit(1);
      if (!role) return failure('ADMIN_ROLE_NOT_FOUND', '管理员角色不存在');
      const grantIssue = validateAdminGrant(actor.roleCode, actor.permissions, role.code, role.permissions);
      if (grantIssue) return failure('ADMIN_GRANT_FORBIDDEN', grantIssue);
      const [existing] = await tx.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.username, input.username)).limit(1);
      if (existing) return failure('ADMIN_USERNAME_EXISTS', '管理员用户名已存在');
      const [user] = await tx.insert(adminUsers).values({
        username: input.username,
        passwordHash,
        roleId: input.roleId,
      }).returning({ id: adminUsers.id, username: adminUsers.username });
      if (!user) throw new Error('ADMIN_USER_CREATE_FAILED');
      await tx.insert(auditEvents).values({
        actorType: 'admin', actorId: input.actorId, action: 'admin_user.created',
        targetType: 'admin_user', targetId: user.id, reason: input.reason,
        metadata: { role_id: input.roleId }, requestId: input.requestId,
      });
      return { ok: true, value: user };
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return failure('ADMIN_USERNAME_EXISTS', '管理员用户名已存在');
    throw error;
  }
}

export async function updateAdminUserAccess(input: {
  actorId: string;
  targetId: string;
  roleId?: string;
  status?: 'active' | 'disabled';
  reason: string;
  requestId: string;
  now?: Date;
}): Promise<AccessResult<{ id: string; roleId: string; status: string }>> {
  if (input.actorId === input.targetId) {
    return failure('ADMIN_SELF_ACCESS_CHANGE_FORBIDDEN', '不能直接修改自己的角色或状态');
  }
  const now = input.now ?? new Date();
  return withAdminTransactionRetry(async (tx) => {
    const actor = await loadGrantActor(tx, input.actorId);
    if (!actor) return failure('ADMIN_GRANT_FORBIDDEN', '当前管理员无权执行授权操作');
    const [target] = await tx.select({
      id: adminUsers.id, roleId: adminUsers.roleId, status: adminUsers.status,
    }).from(adminUsers).where(eq(adminUsers.id, input.targetId)).for('update').limit(1);
    if (!target) return failure('ADMIN_USER_NOT_FOUND', '管理员不存在');
    const roleId = input.roleId ?? target.roleId;
    const status = input.status ?? target.status;
    const [currentRole] = await tx.select({
      code: adminRoles.code,
      permissions: adminRoles.permissions,
    }).from(adminRoles).where(eq(adminRoles.id, target.roleId)).for('update').limit(1);
    if (!currentRole) return failure('ADMIN_ROLE_NOT_FOUND', '管理员当前角色不存在');
    const targetRole = roleId === target.roleId
      ? currentRole
      : (await tx.select({
        code: adminRoles.code,
        permissions: adminRoles.permissions,
      }).from(adminRoles).where(eq(adminRoles.id, roleId)).for('update').limit(1))[0];
    if (!targetRole) return failure('ADMIN_ROLE_NOT_FOUND', '管理员角色不存在');
    const grantIssue = validateAdminRoleMutation(
      actor.roleCode,
      actor.permissions,
      currentRole.code,
      currentRole.permissions,
      targetRole.code,
      targetRole.permissions,
    );
    if (grantIssue) return failure('ADMIN_GRANT_FORBIDDEN', grantIssue);
    const removesSuperAdmin = currentRole?.code === 'super_admin'
      && (roleId !== target.roleId || status !== 'active');
    if (removesSuperAdmin) {
      const activeSuperAdmins = await tx.select({ id: adminUsers.id })
        .from(adminUsers)
        .where(and(eq(adminUsers.roleId, target.roleId), eq(adminUsers.status, 'active')))
        .orderBy(adminUsers.id)
        .for('update');
      if (activeSuperAdmins.length <= 1) {
        return failure('ADMIN_LAST_SUPER_ADMIN_REQUIRED', '系统必须保留至少一个活跃超级管理员');
      }
    }
    await tx.update(adminUsers).set({ roleId, status, updatedAt: now }).where(eq(adminUsers.id, target.id));
    await tx.update(adminSessions).set({ revokedAt: now }).where(and(
      eq(adminSessions.adminUserId, target.id), isNull(adminSessions.revokedAt),
    ));
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: 'admin_user.access_changed',
      targetType: 'admin_user', targetId: target.id, reason: input.reason,
      metadata: {
        before: { role_id: target.roleId, status: target.status },
        after: { role_id: roleId, status },
        sessions_revoked: true,
      },
      requestId: input.requestId,
    });
    return { ok: true, value: { id: target.id, roleId, status } };
  });
}

export async function revokeManagedAdminSessions(input: {
  actorId: string;
  targetId: string;
  reason: string;
  requestId: string;
  now?: Date;
}): Promise<AccessResult<{ id: string }>> {
  const now = input.now ?? new Date();
  return withAdminTransactionRetry(async (tx) => {
    const actor = await loadGrantActor(tx, input.actorId);
    if (!actor) return failure('ADMIN_GRANT_FORBIDDEN', '当前管理员无权执行授权操作');
    const [target] = await tx.select({
      id: adminUsers.id,
      roleCode: adminRoles.code,
      permissions: adminRoles.permissions,
    }).from(adminUsers)
      .innerJoin(adminRoles, eq(adminUsers.roleId, adminRoles.id))
      .where(eq(adminUsers.id, input.targetId))
      .for('update')
      .limit(1);
    if (!target) return failure('ADMIN_USER_NOT_FOUND', '管理员不存在');
    const grantIssue = validateAdminGrant(actor.roleCode, actor.permissions, target.roleCode, target.permissions);
    if (grantIssue) return failure('ADMIN_GRANT_FORBIDDEN', grantIssue);
    await tx.update(adminSessions).set({ revokedAt: now }).where(and(
      eq(adminSessions.adminUserId, target.id), isNull(adminSessions.revokedAt),
    ));
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: 'admin_user.sessions_revoked',
      targetType: 'admin_user', targetId: target.id, reason: input.reason,
      requestId: input.requestId,
    });
    return { ok: true, value: target };
  });
}

export async function createAdminRole(input: {
  actorId: string;
  code: string;
  name: string;
  permissions: string[];
  reason: string;
  requestId: string;
}): Promise<AccessResult<{ id: string; code: string }>> {
  const permissionIssue = validateAdminPermissions(input.permissions);
  if (permissionIssue) return failure('ADMIN_PERMISSION_INVALID', permissionIssue);
  try {
    return await withAdminTransactionRetry(async (tx) => {
      const actor = await loadGrantActor(tx, input.actorId);
      if (!actor) return failure('ADMIN_GRANT_FORBIDDEN', '当前管理员无权执行授权操作');
      const grantIssue = validateAdminGrant(actor.roleCode, actor.permissions, input.code, input.permissions);
      if (grantIssue) return failure('ADMIN_GRANT_FORBIDDEN', grantIssue);
      const [existing] = await tx.select({ id: adminRoles.id }).from(adminRoles).where(eq(adminRoles.code, input.code)).limit(1);
      if (existing) return failure('ADMIN_ROLE_EXISTS', '角色代码已存在');
      const [role] = await tx.insert(adminRoles).values({
        code: input.code, name: input.name, permissions: [...new Set(input.permissions)],
      }).returning({ id: adminRoles.id, code: adminRoles.code });
      if (!role) throw new Error('ADMIN_ROLE_CREATE_FAILED');
      await tx.insert(auditEvents).values({
        actorType: 'admin', actorId: input.actorId, action: 'admin_role.created',
        targetType: 'admin_role', targetId: role.id, reason: input.reason,
        metadata: { code: role.code, permissions: input.permissions }, requestId: input.requestId,
      });
      return { ok: true, value: role };
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return failure('ADMIN_ROLE_EXISTS', '角色代码已存在');
    throw error;
  }
}

export async function updateAdminRole(input: {
  actorId: string;
  roleId: string;
  name: string;
  permissions: string[];
  reason: string;
  requestId: string;
  now?: Date;
}): Promise<AccessResult<{ id: string; code: string }>> {
  const permissionIssue = validateAdminPermissions(input.permissions);
  if (permissionIssue) return failure('ADMIN_PERMISSION_INVALID', permissionIssue);
  const now = input.now ?? new Date();
  return withAdminTransactionRetry(async (tx) => {
    const actor = await loadGrantActor(tx, input.actorId);
    if (!actor) return failure('ADMIN_GRANT_FORBIDDEN', '当前管理员无权执行授权操作');
    const [role] = await tx.select().from(adminRoles).where(eq(adminRoles.id, input.roleId)).for('update').limit(1);
    if (!role) return failure('ADMIN_ROLE_NOT_FOUND', '管理员角色不存在');
    if (role.code === 'super_admin') return failure('ADMIN_SUPER_ROLE_IMMUTABLE', '超级管理员角色不可修改');
    const permissions = [...new Set(input.permissions)];
    const grantIssue = validateAdminRoleMutation(
      actor.roleCode,
      actor.permissions,
      role.code,
      role.permissions,
      role.code,
      permissions,
    );
    if (grantIssue) return failure('ADMIN_GRANT_FORBIDDEN', grantIssue);
    await tx.update(adminRoles).set({ name: input.name, permissions }).where(eq(adminRoles.id, role.id));
    const affectedUsers = await tx.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.roleId, role.id));
    const affectedIds = affectedUsers.map((user) => user.id);
    if (affectedIds.length > 0) {
      await tx.update(adminSessions).set({ revokedAt: now }).where(and(
        inArray(adminSessions.adminUserId, affectedIds), isNull(adminSessions.revokedAt),
      ));
    }
    await tx.insert(auditEvents).values({
      actorType: 'admin', actorId: input.actorId, action: 'admin_role.updated',
      targetType: 'admin_role', targetId: role.id, reason: input.reason,
      metadata: {
        before: { name: role.name, permissions: role.permissions },
        after: { name: input.name, permissions },
        affected_sessions_revoked: affectedIds.length > 0,
      },
      requestId: input.requestId,
    });
    return { ok: true, value: { id: role.id, code: role.code } };
  });
}

function failure(code: AccessFailureCode, message: string): AccessResult<never> {
  return { ok: false, code, message };
}

async function loadGrantActor(tx: AdminTransaction, actorId: string) {
  const [actor] = await tx.select({
    status: adminUsers.status,
    roleCode: adminRoles.code,
    permissions: adminRoles.permissions,
  }).from(adminUsers)
    .innerJoin(adminRoles, eq(adminUsers.roleId, adminRoles.id))
    .where(eq(adminUsers.id, actorId))
    .for('update')
    .limit(1);
  return actor?.status === 'active' ? actor : null;
}

async function withAdminTransactionRetry<T>(operation: (tx: AdminTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.transaction(operation);
    } catch (error: unknown) {
      if (!isRetryableTransactionError(error) || attempt === 3) throw error;
      // 管理写入量很低；短退避用于消除交叉角色/用户行锁的瞬时死锁，不吞掉其他数据库错误。
      await new Promise((resolve) => setTimeout(resolve, attempt * 25 + Math.floor(Math.random() * 25)));
    }
  }
  throw new Error('ADMIN_TRANSACTION_RETRY_EXHAUSTED');
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === '40P01' || error.code === '40001';
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
