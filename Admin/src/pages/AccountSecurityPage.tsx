import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiRequest, clearAdminCsrf } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import styles from './AccountSecurityPage.module.css';

export function AccountSecurityPage() {
  const { identity } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('current_password') ?? '');
    const newPassword = String(form.get('new_password') ?? '');
    const confirmPassword = String(form.get('confirm_password') ?? '');
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setSaving(true);
    try {
      await apiRequest('/api/v1/admin/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      leaveSession('密码已修改，所有管理会话已撤销，请使用新密码重新登录。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码修改失败');
    } finally {
      setSaving(false);
    }
  };

  const logoutAll = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/api/v1/admin/auth/logout-all', { method: 'POST', body: '{}' });
      leaveSession('全部管理会话已撤销。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '会话撤销失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <header>
        <div><p>个人安全中心</p><h1>账号安全</h1><span>当前账号 {identity?.username} · {identity?.roleCode}。密码变更会立即撤销所有设备上的管理会话。</span></div>
        <span className={styles.mark}><ShieldCheck /><strong>HttpOnly Cookie</strong><small>CSRF 与会话独立轮换</small></span>
      </header>
      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardTitle}><span><KeyRound /></span><div><h2>修改密码</h2><p>新密码至少 12 位，必须同时包含字母和数字，不能包含用户名或使用常见密码。</p></div></div>
          <form onSubmit={changePassword}>
            <label>当前密码<input type="password" name="current_password" required autoComplete="current-password" /></label>
            <label>新密码<input type="password" name="new_password" required minLength={12} maxLength={256} autoComplete="new-password" /></label>
            <label>确认新密码<input type="password" name="confirm_password" required minLength={12} maxLength={256} autoComplete="new-password" /></label>
            {error && <div className={styles.error} role="alert">{error}</div>}
            <button disabled={saving}>{saving ? '正在处理…' : '修改密码并退出'}</button>
          </form>
        </section>
        <aside className={styles.sessionCard}>
          <span className={styles.sessionIcon}><LogOut /></span><h2>撤销所有会话</h2>
          <p>如果怀疑 Cookie 泄露、共用电脑未退出或权限刚刚变化，请立即撤销所有管理会话。</p>
          <ul><li>当前浏览器会立即退出</li><li>其他设备的会话同时失效</li><li>操作写入安全审计日志</li></ul>
          <button onClick={() => void logoutAll()} disabled={saving}>撤销全部会话</button>
        </aside>
      </div>
    </div>
  );
}

function leaveSession(message: string) {
  sessionStorage.setItem('eazypath_admin_notice', message);
  clearAdminCsrf();
  window.dispatchEvent(new Event('eazypath:admin-session-expired'));
}
