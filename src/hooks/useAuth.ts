"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ApiError, AuthTokens, User } from "@/lib/types";

/**
 * Authentication against the server: a bcrypt-backed account, a 15-minute
 * access JWT and a rotating refresh token. Two properties are deliberate:
 *
 *  - **sessionStorage, not localStorage.** Closing the tab signs you out, so a
 *    shared device never silently resumes someone's session.
 *  - The route guards in /admin and /consumer still re-check on mount.
 *
 * Tokens are module-level as well as in sessionStorage so that the non-React
 * API helpers in useGridWebSocket.ts can read the current access token without
 * every call site threading it through.
 */

const AUTH_KEY = "dsm_auth";

interface StoredAuth {
  access_token: string;
  refresh_token: string;
  user: User;
}

// ── Module-level token state ──
// Read by authHeader() and the WebSocket URL builder. Kept in step with
// sessionStorage by the two writers below, and nowhere else.
let memoryAuth: StoredAuth | null = null;
const subscribers = new Set<(auth: StoredAuth | null) => void>();

function setAuthEverywhere(auth: StoredAuth | null) {
  memoryAuth = auth;
  try {
    if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    else sessionStorage.removeItem(AUTH_KEY);
  } catch {
    // Private-mode storage failures shouldn't break an otherwise-valid session;
    // it just won't survive a reload.
  }
  subscribers.forEach((fn) => fn(auth));
}

function readStoredAuth(): StoredAuth | null {
  if (memoryAuth) return memoryAuth;
  try {
    const raw = sessionStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed.access_token || !parsed.user) return null;
    memoryAuth = parsed;
    return parsed;
  } catch {
    try {
      sessionStorage.removeItem(AUTH_KEY);
    } catch {
      /* nothing left to do */
    }
    return null;
  }
}

/** The current access token, or null. Used to build authorised requests. */
export function accessToken(): string | null {
  return readStoredAuth()?.access_token ?? null;
}

/** The signed-in account from storage, or null. Synchronous; no network. */
export function currentUser(): User | null {
  return readStoredAuth()?.user ?? null;
}

/**
 * Bearer header for the current access token, or `{}` when signed out.
 *
 * Returning an empty object rather than throwing lets callers spread it
 * unconditionally into a fetch init.
 */
export function authHeader(): Record<string, string> {
  const token = accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Drop the session locally. Exported so a 4401 socket close can call it. */
export function clearSession() {
  setAuthEverywhere(null);
}

const api = (path: string) => path;

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (detail && typeof detail === "object" && detail.message) return detail as ApiError;
    if (typeof detail === "string") return { code: "error", message: detail };
  } catch {
    /* fall through to the status-based message */
  }
  return { code: `http_${res.status}`, message: `Request failed (${res.status}).` };
}

/**
 * Exchange the refresh token for a new pair.
 *
 * Single-flight: rotation invalidates the old token, so two concurrent refreshes
 * would race and the loser's token would be treated as *reuse* — which the
 * backend answers by revoking the whole family and logging everyone out. The
 * shared promise makes that impossible.
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const stored = readStoredAuth();
    if (!stored?.refresh_token) return false;
    try {
      const res = await fetch(api("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: stored.refresh_token }),
      });
      if (!res.ok) {
        clearSession();
        return false;
      }
      const tokens = (await res.json()) as AuthTokens;
      setAuthEverywhere({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user: tokens.user,
      });
      return true;
    } catch {
      // A network blip is not a bad session — keep the tokens and let the
      // caller surface the failure, rather than logging the user out because
      // the Wi-Fi dropped for a second.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * fetch() with the access token attached, retried once through a refresh on 401.
 *
 * Every backend call in the app goes through this. The retry is what makes a
 * 15-minute access token invisible: without it, a dashboard left open would
 * start failing a quarter of an hour in.
 */
export async function fetchWithAuth(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(api(path), {
      ...init,
      headers: { ...(init.headers ?? {}), ...authHeader() },
    });

  let res = await send();
  if (res.status === 401 && (await refreshSession())) {
    res = await send();
  }
  return res;
}

interface UseAuthReturn {
  isAuthenticated: boolean;
  role: "admin" | "consumer" | null;
  username: string | null;
  user: User | null;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: ApiError }>;
  register: (
    username: string,
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: ApiError }>;
  logout: () => void;
  isLoading: boolean;
}

/**
 * Session state and the actions that change it.
 *
 * Reads from localStorage on mount, so `isLoading` is true for the first
 * render and a guard that redirects before checking it will bounce a
 * signed-in user on every reload.
 */
export function useAuth(): UseAuthReturn {
  const [auth, setAuth] = useState<StoredAuth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // Hydrate from sessionStorage after mount, and stay subscribed so that a
  // token refresh or a forced sign-out elsewhere re-renders this hook too.
  useEffect(() => {
    let cancelled = false;
    const stored = readStoredAuth();

    const onChange = (next: StoredAuth | null) => {
      if (!cancelled) setAuth(next);
    };
    subscribers.add(onChange);

    queueMicrotask(() => {
      if (cancelled) return;
      setAuth(stored);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
      subscribers.delete(onChange);
    };
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      try {
        const res = await fetch(api("/api/auth/login"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim().toLowerCase(), password }),
        });
        if (!res.ok) return { success: false, error: await parseError(res) };

        const tokens = (await res.json()) as AuthTokens;
        setAuthEverywhere({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          user: tokens.user,
        });
        router.push(tokens.user.role === "admin" ? "/admin" : "/consumer");
        return { success: true };
      } catch {
        return {
          success: false,
          error: {
            code: "network",
            message: "Cannot reach the server. Is `npm run dev` still running?",
          },
        };
      }
    },
    [router]
  );

  const register = useCallback(async (username: string, email: string, password: string) => {
    try {
      const res = await fetch(api("/api/auth/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim().toLowerCase(),
          email: email.trim().toLowerCase(),
          password,
        }),
      });
      if (!res.ok) return { success: false, error: await parseError(res) };
      // No tokens on purpose — the account is pending until an operator
      // approves it, so there is nothing to sign in to yet.
      return { success: true };
    } catch {
      return {
        success: false,
        error: {
          code: "network",
          message: "Cannot reach the server. Is `npm run dev` still running?",
        },
      };
    }
  }, []);

  const logout = useCallback(() => {
    const stored = readStoredAuth();
    if (stored?.refresh_token) {
      // Fire-and-forget: the local session is gone either way, and a failed
      // revoke should not keep the user staring at a spinner.
      fetch(api("/api/auth/logout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: stored.refresh_token }),
      }).catch(() => {});
    }
    clearSession();
    router.push("/login");
  }, [router]);

  return {
    isAuthenticated: auth !== null,
    role: auth?.user.role ?? null,
    username: auth?.user.username ?? null,
    user: auth?.user ?? null,
    login,
    register,
    logout,
    isLoading,
  };
}
