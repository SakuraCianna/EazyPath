import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { PlacesPage } from './pages/PlacesPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { PlatformLinksPage } from './pages/PlatformLinksPage';
import { OperationalListPage } from './pages/OperationalListPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminAccessPage } from './pages/AdminAccessPage';
import { AccountSecurityPage } from './pages/AccountSecurityPage';

export function App() {
  const { identity, loading } = useAuth();
  if (loading) {
    return <div className="appBoot" role="status"><span className="appBootMark" aria-hidden="true" />正在验证管理会话…</div>;
  }
  if (!identity) {
    return <Routes><Route path="*" element={<LoginPage />} /></Routes>;
  }
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="places" element={<PlacesPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="community" element={<OperationalListPage kind="community" />} />
        <Route path="verifications" element={<Navigate to="/reviews?queue=verifications" replace />} />
        <Route path="users" element={<OperationalListPage kind="users" />} />
        <Route path="tasks" element={<OperationalListPage kind="tasks" />} />
        <Route path="platform-links" element={<PlatformLinksPage />} />
        <Route path="media" element={<OperationalListPage kind="media" />} />
        <Route path="admin-users" element={<AdminAccessPage />} />
        <Route path="audit" element={<OperationalListPage kind="audit" />} />
        <Route path="account-security" element={<AccountSecurityPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
