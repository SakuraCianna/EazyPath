import { describe, expect, it } from 'vitest';
import {
  ADMIN_LOGIN_LOCK_MS,
  isAdminLoginFailureLocked,
  isAdminSessionIdle,
  nextLoginFailureState,
  shouldTouchAdminSession,
  validateAdminPermissions,
  validateAdminGrant,
  validateAdminRoleMutation,
  validateAdminPassword,
} from './admin-security.js';

describe('管理员会话安全规则', () => {
  const now = new Date('2026-08-09T00:00:00.000Z');

  it('30 分钟未活动时失效，1 分钟后允许刷新活动时间', () => {
    expect(isAdminSessionIdle(new Date(now.getTime() - 30 * 60 * 1000), now)).toBe(true);
    expect(isAdminSessionIdle(new Date(now.getTime() - 29 * 60 * 1000), now)).toBe(false);
    expect(shouldTouchAdminSession(new Date(now.getTime() - 60 * 1000), now)).toBe(true);
    expect(shouldTouchAdminSession(new Date(now.getTime() - 59 * 1000), now)).toBe(false);
  });

  it('连续第五次失败锁定 15 分钟，锁定到期后重新计数', () => {
    const locked = nextLoginFailureState(4, null, now);
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil?.getTime()).toBe(now.getTime() + ADMIN_LOGIN_LOCK_MS);

    const afterExpiry = nextLoginFailureState(5, new Date(now.getTime() - 1), now);
    expect(afterExpiry).toEqual({ failedLoginCount: 1, lockedUntil: null });
  });

  it('锁定只阻止错误密码，正确密码可恢复管理员访问', () => {
    const lockedUntil = new Date(now.getTime() + ADMIN_LOGIN_LOCK_MS);
    expect(isAdminLoginFailureLocked(false, lockedUntil, now)).toBe(true);
    expect(isAdminLoginFailureLocked(true, lockedUntil, now)).toBe(false);
    expect(isAdminLoginFailureLocked(false, new Date(now.getTime() - 1), now)).toBe(false);
  });

  it('拒绝短密码、常见密码、包含用户名和缺少数字的密码', () => {
    expect(validateAdminPassword('short1')).toContain('12');
    expect(validateAdminPassword('password1234')).toContain('常见');
    expect(validateAdminPassword('SakuraSecure2026', 'sakura')).toContain('用户名');
    expect(validateAdminPassword('LongPasswordOnly')).toContain('字母和数字');
    expect(validateAdminPassword('RiverStone2026!')).toBeNull();
  });

  it('角色权限必须来自受控字典且通配权限不可混用', () => {
    expect(validateAdminPermissions([])).toContain('至少');
    expect(validateAdminPermissions(['*', 'dashboard.read'])).toContain('不能');
    expect(validateAdminPermissions(['dashboard.read', 'unknown.read'])).toContain('unknown.read');
    expect(validateAdminPermissions(['dashboard.read', 'reviews.read'])).toBeNull();
    expect(validateAdminPermissions(['*'])).toBeNull();
  });

  it('普通管理员只能授予自身权限子集，超级管理员可执行受控授权', () => {
    const actorPermissions = ['admin_users.manage', 'dashboard.read'];
    expect(validateAdminGrant('operator', actorPermissions, 'viewer', ['dashboard.read'])).toBeNull();
    expect(validateAdminGrant('operator', actorPermissions, 'super_admin', ['*'])).toContain('超级管理员');
    expect(validateAdminGrant('operator', actorPermissions, 'reviewer', ['reviews.decide'])).toContain('超出');
    expect(validateAdminGrant('super_admin', ['*'], 'reviewer', ['reviews.decide'])).toBeNull();
  });

  it('普通管理员不能通过降级或改写其上级角色绕过授权上限', () => {
    const actorPermissions = ['admin_users.manage', 'dashboard.read'];
    expect(validateAdminRoleMutation(
      'operator', actorPermissions, 'super_admin', ['*'], 'viewer', ['dashboard.read'],
    )).toContain('超级管理员');
    expect(validateAdminRoleMutation(
      'operator', actorPermissions, 'auditor', ['audit.read'], 'viewer', ['dashboard.read'],
    )).toContain('audit.read');
    expect(validateAdminRoleMutation(
      'operator', actorPermissions, 'viewer', ['dashboard.read'], 'viewer', ['dashboard.read'],
    )).toBeNull();
  });
});
