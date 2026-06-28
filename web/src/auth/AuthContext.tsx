import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, APIError } from "../api/client";
import type { AuthConfig, User } from "../api/types";

interface AuthState {
  user: User | null;
  config: AuthConfig | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [cfg, me] = await Promise.allSettled([api.authConfig(), api.me()]);
        if (cfg.status === "fulfilled") setConfig(cfg.value);
        if (me.status === "fulfilled") setUser(me.value);
        else if (me.status === "rejected" && !(me.reason instanceof APIError))
          console.error(me.reason);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password));
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      setUser(await api.register(email, password, displayName));
    },
    [],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, config, loading, login, register, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
