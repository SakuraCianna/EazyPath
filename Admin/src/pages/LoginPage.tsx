import { Accessibility, ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { login } = useAuth();
  const [notice] = useState(() => {
    const value = sessionStorage.getItem('eazypath_admin_notice');
    sessionStorage.removeItem('eazypath_admin_notice');
    return value;
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError(null);
    try { await login(username, password); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
    finally { setLoading(false); }
  };
  return (
    <main className={styles.page}>
      <section className={styles.context}>
        <div className={styles.logo}><Accessibility /><span>EazyPath</span></div>
        <div><p className={styles.eyebrow}>江西无障碍出行运营中枢</p><h1>让每一条“可通行”结论，都有证据可追溯。</h1><p>审核社区现场信息、处理冲突、查看 Agent 与 BullMQ 状态，并维护经过验证的平台入口。</p></div>
        <div className={styles.privacy}><ShieldCheck /><span><strong>隐私优先</strong>AI 验真原图用完即删，社区只保留用户确认脱敏后的证据。</span></div>
      </section>
      <section className={styles.loginPanel} aria-labelledby="login-title">
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.formIcon}><LockKeyhole /></div>
          <p className={styles.eyebrow}>管理员安全入口</p><h2 id="login-title">登录管理后台</h2><p className={styles.help}>账号由部署引导或超级管理员创建。</p>
          {notice && <div className={styles.notice} role="status">{notice}</div>}
          <label>用户名<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {error && <div className={styles.error} role="alert">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? '正在验证…' : <>安全登录<ArrowRight size={18} /></>}</button>
          <small>登录入口启用来源限流、并发保护和统一失败响应，所有安全事件都会进入审计日志。</small>
        </form>
      </section>
    </main>
  );
}
