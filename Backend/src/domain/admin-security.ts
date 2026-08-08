export const ADMIN_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ADMIN_SESSION_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
export const ADMIN_LOGIN_MAX_FAILURES = 5;
export const ADMIN_LOGIN_LOCK_MS = 15 * 60 * 1000;
export const ADMIN_PERMISSION_CODES = [
  'dashboard.read',
  'places.read',
  'places.write',
  'reviews.read',
  'reviews.decide',
  'platform_links.read',
  'platform_links.manage',
  'tasks.read',
  'verifications.read',
  'installations.read',
  'admin_users.read',
  'admin_users.manage',
  'audit.read',
  'media.read',
  'system.read',
] as const;

const adminPermissionCodeSet = new Set<string>(ADMIN_PERMISSION_CODES);

const weakPasswords = new Set([
  '123456789012',
  'admin123456',
  'administrator',
  'password1234',
  'qwerty123456',
]);

export interface LoginFailureState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export function isAdminSessionIdle(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= ADMIN_SESSION_IDLE_TIMEOUT_MS;
}

export function shouldTouchAdminSession(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= ADMIN_SESSION_TOUCH_INTERVAL_MS;
}

export function nextLoginFailureState(
  previousCount: number,
  previousLockedUntil: Date | null,
  now: Date,
): LoginFailureState {
  const lockExpired = previousLockedUntil !== null && previousLockedUntil <= now;
  const failedLoginCount = (lockExpired ? 0 : previousCount) + 1;
  return {
    failedLoginCount,
    lockedUntil: failedLoginCount >= ADMIN_LOGIN_MAX_FAILURES
      ? new Date(now.getTime() + ADMIN_LOGIN_LOCK_MS)
      : null,
  };
}

export function isAdminLoginFailureLocked(
  passwordValid: boolean,
  lockedUntil: Date | null,
  now: Date,
): boolean {
  return !passwordValid && lockedUntil !== null && lockedUntil > now;
}

export function validateAdminPassword(password: string, username?: string): string | null {
  if (password.length < 12) return '管理员密码至少需要 12 个字符';
  const normalized = password.toLowerCase();
  if (weakPasswords.has(normalized)) return '管理员密码过于常见';
  if (username && normalized.includes(username.toLowerCase())) return '管理员密码不能包含用户名';
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return '管理员密码必须同时包含字母和数字';
  return null;
}

export function validateAdminPermissions(permissions: string[]): string | null {
  if (permissions.length === 0) return '角色至少需要一个权限';
  if (permissions.includes('*')) return permissions.length === 1 ? null : '通配权限不能与其他权限混用';
  const unknown = permissions.find((permission) => !adminPermissionCodeSet.has(permission));
  return unknown ? `未知管理员权限: ${unknown}` : null;
}

export function validateAdminGrant(
  actorRoleCode: string,
  actorPermissions: string[],
  targetRoleCode: string,
  targetPermissions: string[],
): string | null {
  if (actorRoleCode === 'super_admin') return null;
  if (targetRoleCode === 'super_admin' || targetPermissions.includes('*')) {
    return '只有超级管理员可以授予超级管理员角色或通配权限';
  }
  const actorPermissionSet = new Set(actorPermissions);
  const elevatedPermission = targetPermissions.find((permission) => !actorPermissionSet.has(permission));
  return elevatedPermission ? `不能授予超出自身范围的权限: ${elevatedPermission}` : null;
}

export function validateAdminRoleMutation(
  actorRoleCode: string,
  actorPermissions: string[],
  currentRoleCode: string,
  currentPermissions: string[],
  targetRoleCode: string,
  targetPermissions: string[],
): string | null {
  return validateAdminGrant(actorRoleCode, actorPermissions, currentRoleCode, currentPermissions)
    ?? validateAdminGrant(actorRoleCode, actorPermissions, targetRoleCode, targetPermissions);
}
