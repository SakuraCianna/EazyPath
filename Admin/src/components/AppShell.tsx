import {
  Accessibility,
  Bot,
  ChevronDown,
  ClipboardCheck,
  Database,
  FileClock,
  Gauge,
  Image,
  ListChecks,
  LogOut,
  MapPinned,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import styles from './AppShell.module.css';

const navigation = [
  { to: '/', label: '总览', icon: Gauge, end: true },
  { to: '/places', label: '地点与路线', icon: MapPinned },
  { to: '/reviews', label: '证据审核', icon: ClipboardCheck },
  { to: '/community', label: '社区复核', icon: Users },
  { to: '/verifications', label: 'AI 验真', icon: Bot },
  { to: '/users', label: '用户', icon: Accessibility },
  { to: '/tasks', label: 'Agent 任务', icon: ListChecks },
  { to: '/platform-links', label: '平台配置', icon: SlidersHorizontal },
  { to: '/media', label: '本地媒体', icon: Image },
  { to: '/admin-users', label: '管理员', icon: UserCog },
  { to: '/audit', label: '审计日志', icon: FileClock },
  { to: '/settings', label: '系统设置', icon: Settings },
];

export function AppShell() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { username, logout } = useAuth();
  const navigate = useNavigate();
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (search.trim()) navigate(`/places?search=${encodeURIComponent(search.trim())}`);
  };
  return (
    <div className={styles.shell}>
      <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ''}`} aria-label="主导航">
        <div className={styles.brand}>
          <span className={styles.brandMark}><Accessibility size={25} /></span>
          <span><strong>EazyPath</strong><small>无障碍出行管理台</small></span>
          <button className={styles.closeButton} onClick={() => setOpen(false)} aria-label="关闭导航"><X /></button>
        </div>
        <nav className={styles.navList}>
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setOpen(false)} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
              <Icon size={20} aria-hidden="true" /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.sidebarFooter}><ShieldCheck size={18} /><span>最小权限 · 审计开启</span></div>
      </aside>
      {open && <button className={styles.scrim} aria-label="关闭导航" onClick={() => setOpen(false)} />}
      <div className={styles.mainColumn}>
        <header className={styles.topBar}>
          <button className={styles.menuButton} onClick={() => setOpen(true)} aria-label="打开导航"><Menu /></button>
          <form className={styles.search} onSubmit={submitSearch} role="search">
            <Search size={20} aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索江西地点或地址" aria-label="搜索江西地点或地址" />
          </form>
          <button className={styles.regionButton}><MapPinned size={18} />江西省 / 南昌市<ChevronDown size={16} /></button>
          <div className={styles.account}>
            <span className={styles.avatar}>{username?.slice(0, 1).toUpperCase()}</span>
            <span className={styles.accountText}><strong>{username}</strong><small>管理员</small></span>
            <button onClick={() => void logout()} className={styles.logoutButton} aria-label="退出登录"><LogOut size={19} /></button>
          </div>
        </header>
        <main className={styles.content}><Outlet /></main>
      </div>
    </div>
  );
}
