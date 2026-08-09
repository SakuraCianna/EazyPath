import { KeyRound, Plus, RefreshCw, Search, Shield, ShieldCheck, UserCog, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { apiRequest, formatDate } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import { useModalDialog } from '../hooks/useModalDialog';
import styles from './AdminAccessPage.module.css';

interface AdminUser {
  id: string;
  username: string;
  status: 'active' | 'disabled';
  roleId: string;
  roleCode: string;
  roleName: string;
  lastLoginAt: string | null;
  createdAt: string;
}

interface AdminRole {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  createdAt: string;
}

interface RolesResponse { items: AdminRole[]; available_permissions: string[] }

export function AdminAccessPage() {
  const { hasPermission, identity } = useAuth();
  const canManage = hasPermission('admin_users.manage');
  const canGrantAll = identity?.roleCode === 'super_admin';
  const users = useApiData<AdminUser[]>('/api/v1/admin/admin-users');
  const roles = useApiData<RolesResponse>('/api/v1/admin/roles');
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [query, setQuery] = useState('');
  const [createUser, setCreateUser] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [selectedRole, setSelectedRole] = useState<AdminRole | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const filteredUsers = useMemo(() => (users.data ?? []).filter((item) => `${item.username} ${item.roleName} ${item.roleCode}`.toLowerCase().includes(query.toLowerCase())), [query, users.data]);
  const filteredRoles = useMemo(() => (roles.data?.items ?? []).filter((item) => `${item.name} ${item.code} ${item.permissions.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [query, roles.data]);
  const canGrantPermissions = (permissions: string[]) => Boolean(identity?.permissions.includes('*') || (!permissions.includes('*') && permissions.every((permission) => identity?.permissions.includes(permission))));
  const grantableRoles = (roles.data?.items ?? []).filter((role) => canGrantPermissions(role.permissions));
  const grantablePermissions = (roles.data?.available_permissions ?? []).filter((permission) => permission !== '*' ? identity?.permissions.includes('*') || identity?.permissions.includes(permission) : canGrantAll);
  const reload = async () => { await Promise.all([users.reload(), roles.reload()]); };

  return <div className={styles.page}>
    <header className={styles.hero}><div><p>身份与最小权限</p><h1>管理员与角色</h1><span>角色变更会立即撤销受影响会话；普通管理员只能授予不高于自身的权限集合。</span></div><span className={styles.securityMark}><ShieldCheck /><strong>RBAC 已启用</strong><small>所有变更必须说明理由</small></span></header>
    <div className={styles.tabBar} role="tablist" aria-label="管理员访问控制"><button role="tab" aria-selected={tab === 'users'} className={tab === 'users' ? styles.active : ''} onClick={() => setTab('users')}><UserCog />管理员账号</button><button role="tab" aria-selected={tab === 'roles'} className={tab === 'roles' ? styles.active : ''} onClick={() => setTab('roles')}><Shield />角色与权限</button></div>
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.toolbar}><label><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选用户名、角色或权限" /></label><button className={styles.refresh} onClick={() => void reload()}><RefreshCw />刷新</button>{canManage && <button className={styles.primary} onClick={() => tab === 'users' ? setCreateUser(true) : setSelectedRole('new')}><Plus />{tab === 'users' ? '新增管理员' : '新增角色'}</button>}</div>
    {tab === 'users' ? <section className={styles.card}><PageState loading={users.loading || roles.loading} error={users.error ?? roles.error} empty={!users.loading && filteredUsers.length === 0} onRetry={reload} />{filteredUsers.length > 0 && <div className={styles.tableWrap}><table><thead><tr><th>管理员</th><th>角色</th><th>状态</th><th>最后登录</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{filteredUsers.map((user) => <tr key={user.id}><td><strong>{user.username}</strong><small>{user.id}</small></td><td><span className={styles.roleChip}>{user.roleName}</span><small>{user.roleCode}</small></td><td><span className={user.status === 'active' ? styles.good : styles.bad}>{user.status === 'active' ? '启用' : '停用'}</span></td><td>{formatDate(user.lastLoginAt)}</td><td>{formatDate(user.createdAt)}</td><td><button className={styles.rowAction} onClick={() => setSelectedUser(user)}>{canManage ? '管理' : '查看'}</button></td></tr>)}</tbody></table></div>}</section> : <section className={styles.roleGrid}><PageState loading={roles.loading} error={roles.error} empty={!roles.loading && filteredRoles.length === 0} onRetry={roles.reload} />{filteredRoles.map((role) => <button key={role.id} className={styles.roleCard} onClick={() => setSelectedRole(role)}><span className={styles.roleIcon}><KeyRound /></span><span><strong>{role.name}</strong><small>{role.code}</small><span>{role.permissions.includes('*') ? '全部权限' : `${role.permissions.length} 项权限`}</span></span></button>)}</section>}
    {createUser && roles.data && <CreateUserPanel roles={grantableRoles} onClose={() => setCreateUser(false)} onSaved={async () => { setCreateUser(false); await reload(); setNotice('管理员账号已创建'); }} />}
    {selectedUser && roles.data && <ManageUserPanel user={selectedUser} roles={grantableRoles} canManage={canManage && canGrantPermissions(roles.data.items.find((role) => role.id === selectedUser.roleId)?.permissions ?? ['*'])} onClose={() => setSelectedUser(null)} onSaved={async (message) => { setSelectedUser(null); await reload(); setNotice(message); }} />}
    {selectedRole && roles.data && <RolePanel role={selectedRole} availablePermissions={grantablePermissions} canManage={canManage && (selectedRole === 'new' || canGrantPermissions(selectedRole.permissions))} canGrantAll={canGrantAll} onClose={() => setSelectedRole(null)} onSaved={async () => { setSelectedRole(null); await reload(); setNotice(selectedRole === 'new' ? '角色已创建' : '角色权限已更新'); }} />}
  </div>;
}

function CreateUserPanel({ roles, onClose, onSaved }: { roles: AdminRole[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setSaving(true); setError(null); const form = new FormData(event.currentTarget); try { await apiRequest('/api/v1/admin/admin-users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password'), role_id: form.get('role_id'), reason: form.get('reason') }) }); await onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败'); } finally { setSaving(false); } };
  return <Panel title="新增管理员" subtitle="创建后可随时调整角色或停用账号" onClose={onClose}><form className={styles.form} onSubmit={submit}><label>用户名<input name="username" required minLength={3} maxLength={64} pattern="[a-z0-9._-]+" autoComplete="off" /></label><label>初始强密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" /></label><label>角色<select name="role_id" required defaultValue=""><option value="" disabled>选择角色</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} ({role.code})</option>)}</select></label><ReasonField />{error && <div className={styles.error}>{error}</div>}<button className={styles.submit} disabled={saving}>{saving ? '创建中…' : '创建管理员'}</button></form></Panel>;
}

function ManageUserPanel({ user, roles, canManage, onClose, onSaved }: { user: AdminUser; roles: AdminRole[]; canManage: boolean; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [roleId, setRoleId] = useState(user.roleId); const [status, setStatus] = useState(user.status); const [reason, setReason] = useState(''); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { await apiRequest(`/api/v1/admin/admin-users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role_id: roleId, status, reason }) }); await onSaved('管理员角色与状态已更新'); } catch (cause) { setError(cause instanceof Error ? cause.message : '更新失败'); } finally { setSaving(false); } };
  const revoke = async () => { if (reason.trim().length < 6) { setError('撤销会话前请填写至少 6 个字符的理由'); return; } setSaving(true); setError(null); try { await apiRequest(`/api/v1/admin/admin-users/${user.id}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason }) }); await onSaved('该管理员的全部会话已撤销'); } catch (cause) { setError(cause instanceof Error ? cause.message : '撤销失败'); } finally { setSaving(false); } };
  return <Panel title={user.username} subtitle={`${user.roleName} · ${user.status}`} onClose={onClose}><form className={styles.form} onSubmit={save}><label>角色<select value={roleId} onChange={(event) => setRoleId(event.target.value)} disabled={!canManage}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} ({role.code})</option>)}</select></label><label>账号状态<select value={status} onChange={(event) => setStatus(event.target.value as AdminUser['status'])} disabled={!canManage}><option value="active">启用</option><option value="disabled">停用</option></select></label><label>操作理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={6} maxLength={1000} disabled={!canManage} /></label>{error && <div className={styles.error}>{error}</div>}{canManage ? <div className={styles.actionRow}><button type="button" className={styles.revoke} onClick={() => void revoke()} disabled={saving}>撤销全部会话</button><button className={styles.submit} disabled={saving || reason.trim().length < 6}>保存变更</button></div> : <div className={styles.readOnly}>当前角色只有查看权限。</div>}</form></Panel>;
}

function RolePanel({ role, availablePermissions, canManage, canGrantAll, onClose, onSaved }: { role: AdminRole | 'new'; availablePermissions: string[]; canManage: boolean; canGrantAll: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const current = role === 'new' ? null : role; const immutable = current?.code === 'super_admin';
  const [name, setName] = useState(current?.name ?? ''); const [code, setCode] = useState(current?.code ?? ''); const [permissions, setPermissions] = useState<string[]>(current?.permissions ?? []); const [reason, setReason] = useState(''); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const toggle = (permission: string) => setPermissions((values) => {
    if (permission === '*') return values.includes('*') ? [] : ['*'];
    return values.includes(permission) ? values.filter((item) => item !== permission) : [...values.filter((item) => item !== '*'), permission];
  });
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { const body = { ...(current ? {} : { code }), name, permissions, reason }; await apiRequest(current ? `/api/v1/admin/roles/${current.id}` : '/api/v1/admin/roles', { method: current ? 'PATCH' : 'POST', body: JSON.stringify(body) }); await onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : '角色保存失败'); } finally { setSaving(false); } };
  const visiblePermissions = canGrantAll ? availablePermissions : availablePermissions.filter((permission) => permission !== '*');
  return <Panel title={current ? current.name : '新增角色'} subtitle={current?.code ?? '定义最小权限集合'} onClose={onClose}><form className={styles.form} onSubmit={submit}>{!current && <label>角色代码<input value={code} onChange={(event) => setCode(event.target.value)} required minLength={3} maxLength={64} pattern="[a-z][a-z0-9_]*" /></label>}<label>角色名称<input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={128} disabled={!canManage || immutable} /></label><fieldset className={styles.permissions} disabled={!canManage || immutable}><legend>权限集合</legend>{visiblePermissions.map((permission) => <label key={permission}><input type="checkbox" checked={permission === '*' ? permissions.includes('*') : permissions.includes('*') || permissions.includes(permission)} onChange={() => toggle(permission)} disabled={permissions.includes('*') && permission !== '*'} /><span>{permission}</span></label>)}</fieldset><label>变更理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={6} maxLength={1000} disabled={!canManage || immutable} /></label>{immutable && <div className={styles.readOnly}>super_admin 角色由系统保护，不允许通过此界面修改。</div>}{error && <div className={styles.error}>{error}</div>}{canManage && !immutable && <button className={styles.submit} disabled={saving || permissions.length === 0 || reason.trim().length < 6}>{saving ? '保存中…' : current ? '保存角色' : '创建角色'}</button>}</form></Panel>;
}

function ReasonField() { return <label>创建理由<textarea name="reason" required minLength={6} maxLength={1000} placeholder="说明职责范围和授权依据" /></label>; }
function Panel({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) { const dialogRef = useModalDialog(onClose); return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={dialogRef} tabIndex={-1} className={styles.panel} role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2><span>{subtitle}</span></div><button onClick={onClose} aria-label="关闭"><X /></button></header>{children}</aside></div>; }
