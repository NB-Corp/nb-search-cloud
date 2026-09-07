import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiClientError } from '../services/client.js';
import { authNotifier } from '../services/auth-events.js';
import type { SessionDto, UserDto } from '../types/api.js';

interface AuthContextValue {
  session: SessionDto | null;
  user: UserDto | null;
  loading: boolean;
  login: (tenant: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = async () => {
    try {
      const current = await api.auth.session();
      setSession(current);
    } catch (err) {
      if (err instanceof ApiClientError && (err.statusCode === 401 || err.code === 'AUTH_REQUIRED')) {
        setSession(null);
      } else {
        console.warn('Session refresh error:', err);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshSession();

    const unsubscribe = authNotifier.onUnauthorized(() => {
      setSession(null);
    });
    return unsubscribe;
  }, []);

  const login = async (tenant: string, username: string, password: string) => {
    const s = await api.auth.login(tenant, username, password);
    setSession(s);
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } finally {
      setSession(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session ? session.user : null,
        loading,
        login,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
