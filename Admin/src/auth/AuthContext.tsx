import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { apiRequest, clearAdminCsrf, restoreAdminCsrf, setAdminCsrf } from '../api/client';

export interface AdminIdentity {
  id: string;
  username: string;
  roleCode: string;
  permissions: string[];
}

interface AuthState {
  identity: AdminIdentity | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const user = await apiRequest<{ id: string; username: string; role_code: string; permissions: string[] }>('/api/v1/admin/auth/me');
        await restoreAdminCsrf();
        if (!active) return;
        setIdentity({ id: user.id, username: user.username, roleCode: user.role_code, permissions: user.permissions });
      } catch {
        if (!active) return;
        clearAdminCsrf(false);
        setIdentity(null);
      } finally {
        if (active) setLoading(false);
      }
    };
    const expire = () => {
      clearAdminCsrf();
      setIdentity(null);
      setLoading(false);
    };
    window.addEventListener('eazypath:admin-session-expired', expire);
    void restore();
    return () => {
      active = false;
      window.removeEventListener('eazypath:admin-session-expired', expire);
    };
  }, []);

  const value = useMemo<AuthState>(() => ({
    identity,
    loading,
    login: async (nextUsername, password) => {
      const result = await apiRequest<{
        user: { id: string; username: string; role_code: string; permissions: string[] };
        csrf_token: string;
      }>('/api/v1/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: nextUsername, password }),
      });
      setAdminCsrf(result.csrf_token);
      setIdentity({
        id: result.user.id,
        username: result.user.username,
        roleCode: result.user.role_code,
        permissions: result.user.permissions,
      });
    },
    logout: async () => {
      await apiRequest('/api/v1/admin/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
      clearAdminCsrf();
      setIdentity(null);
    },
    hasPermission: (permission) => Boolean(identity?.permissions.includes('*') || identity?.permissions.includes(permission)),
  }), [identity, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
