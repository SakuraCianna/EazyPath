import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { apiRequest } from '../api/client';

interface AuthState {
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [username, setUsername] = useState<string | null>(() => sessionStorage.getItem('eazypath_admin_username'));
  const value = useMemo<AuthState>(() => ({
    username,
    login: async (nextUsername, password) => {
      const result = await apiRequest<{ username: string; csrf_token: string }>('/api/v1/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: nextUsername, password }),
      });
      sessionStorage.setItem('eazypath_admin_username', result.username);
      sessionStorage.setItem('eazypath_admin_csrf', result.csrf_token);
      setUsername(result.username);
    },
    logout: async () => {
      await apiRequest('/api/v1/admin/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
      sessionStorage.removeItem('eazypath_admin_username');
      sessionStorage.removeItem('eazypath_admin_csrf');
      setUsername(null);
    },
  }), [username]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
