import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

import { api, setSessionLostHandler } from './api';
import type { Role, SignedInUser } from './types';

interface AuthState {
  user: SignedInUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** True when the signed-in employee holds at least this role. */
  atLeast: (role: Role) => boolean;
}

const RANK: Record<Role, number> = { consultant: 1, manager: 2, admin: 3 };

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  signIn: async () => {},
  signOut: async () => {},
  atLeast: () => false,
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.get<{ user: SignedInUser | null }>('/auth/me')
      .then((result) => { if (active) setUser(result.user); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  // Any 401 from an internal route means the session is over.
  useEffect(() => {
    setSessionLostHandler(() => setUser(null));
    return () => setSessionLostHandler(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.post<{ user: SignedInUser }>('/auth/login', { email, password });
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } finally {
      // Whatever the server said, this browser is done with the session.
      setUser(null);
    }
  }, []);

  const atLeast = useCallback(
    (role: Role) => (user ? RANK[user.role] >= RANK[role] : false),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, atLeast }),
    [user, loading, signIn, signOut, atLeast],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
