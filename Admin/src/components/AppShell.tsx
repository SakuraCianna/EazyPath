import {
  Accessibility,
  Bot,
  ClipboardCheck,
  FileClock,
  Gauge,
  Image,
  KeyRound,
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
  { to: '/', label: '运营总览', icon: Gauge, permission: 'dashboard.read', end: true },
  { to: '/places', label: '地点与路线', icon: MapPinned, permission: 'places.read' },
  { to: '/reviews', label: '审核工作台', icon: ClipboardCheck, permission: 'reviews.read' },
  { to: '/community', label: '社区复核', icon: Users, permission: 'reviews.read' },
  { to: '/verifications', label: 'AI 验真', icon: Bot, permission: 'verifications.read' },
  { to: '/users', label: '匿名用户', icon: Accessibility, permission: 'installations.read' },
  { to: '/tasks', label: 'Agent 任务', icon: ListChecks, permission: 'tasks.read' },
  { to: '/platform-links', label: '平台入口', icon: SlidersHorizontal, permission: 'platform_links.read' },
  { to: '/media', label: '证据媒体', icon: Image, permission: 'media.read' },
  { to: '/admin-users', label: '管理员与角色', icon: UserCog, permission: 'admin_users.read' },
  { to: '/audit', label: '审计日志', icon: FileClock, permission: 'audit.read' },
  { to: '/settings', label: '系统状态', icon: Settings, permission: 'system.read' },
  { to: '/account-security', label: '账号安全', icon: KeyRound, permission: null },
];

export function AppShell() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { identity, logout, hasPermission } = useAuth();
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
          {navigation.filter((item) => !item.permission || hasPermission(item.permission)).map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setOpen(false)} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
              <Icon size={20} aria-hidden="true" /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.sidebarFooter}><ShieldCheck size={18} /><span>最小权限</span><small>媒体访问全程审计</small></div>
      </aside>
      {open && <button className={styles.scrim} aria-label="关闭导航" onClick={() => setOpen(false)} />}
      <div className={styles.mainColumn}>
        <header className={styles.topBar}>
          <button className={styles.menuButton} onClick={() => setOpen(true)} aria-label="打开导航"><Menu /></button>
          <form className={styles.search} onSubmit={submitSearch} role="search">
            <Search size={20} aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索江西地点或地址" aria-label="搜索江西地点或地址" />
          </form>
          <div className={styles.regionScope} aria-label="当前数据范围"><MapPinned size={18} /><span><small>首发区域</small>江西 · 南昌</span></div>
          <div className={styles.account}>
            <span className={styles.avatar}>{identity?.username.slice(0, 1).toUpperCase()}</span>
            <span className={styles.accountText}><strong>{identity?.username}</strong><small>{identity?.roleCode}</small></span>
            <button onClick={() => void logout()} className={styles.logoutButton} aria-label="退出登录"><LogOut size={19} /></button>
          </div>
        </header>
        <main className={styles.content}><Outlet /></main>
      </div>
    </div>
  );
}
