import { useState, useEffect, useCallback } from "react";
import { api } from "./api";

export interface AuthState {
  isAuthenticated: boolean;
  username: string | undefined;
  loading: boolean;
}

export interface AuthActions {
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
}

export type UseAuthResult = AuthState & AuthActions;

export async function checkAuth(): Promise<boolean> {
  const result = await api.auth.check();
  return result.authenticated;
}

export function useAuth(): UseAuthResult {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    username: undefined,
    loading: true,
  });

  useEffect(() => {
    api.auth.check().then((result) => {
      setState({
        isAuthenticated: result.authenticated,
        username: result.username,
        loading: false,
      });
    });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.auth.login(username, password);
    if (result.ok) {
      setState({ isAuthenticated: true, username, loading: false });
    }
    return result;
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setState({ isAuthenticated: false, username: undefined, loading: false });
  }, []);

  return { ...state, login, logout };
}
