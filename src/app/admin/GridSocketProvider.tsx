"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useGridWebSocket } from "@/hooks/useGridWebSocket";

/**
 * One admin WebSocket per tab, shared by the shell and the page inside it.
 *
 * ## Why this exists
 *
 * `useGridWebSocket` is per-instance: every call builds its own `wsRef` and
 * opens its own socket in its own effect. That was fine while exactly one
 * component called it. The sidebar needs the same live state — connection,
 * gateway, household count, and the nonces its count badges refetch on — so
 * calling the hook there as well would open a *second* `/ws/admin` socket in
 * the same tab.
 *
 * Two sockets is not a cosmetic problem. Both receive every tick, both keep a
 * full copy of the alert feed, and both handle `system_reset` — so a reset
 * would bump two independent `resetNonce`s and the shell and the page could
 * briefly disagree about what exists. It also doubles tick traffic per tab for
 * nothing. None of that surfaces in the UI; you would only see it in the
 * Network → WS panel.
 *
 * So the hook is called once, here, and everything below reads the context.
 * The hook itself is unchanged and still owns all the reconnect and auth
 * logic — this is a lifting, not a rewrite.
 *
 * ## Why `historyNonce` lives here too
 *
 * It used to be local state in `app/admin/page.tsx`, bumped whenever an
 * operator pushed, ignored or sent something. The sidebar's count badges read
 * the `/count` endpoints and have to refetch on exactly that signal, so it has
 * to be reachable from both. Leaving it on the page freezes the badges after a
 * push — silently, with no error.
 */

type GridSocket = ReturnType<typeof useGridWebSocket>;

interface AdminSocketValue extends GridSocket {
  /** Bumped by any operator action that changes stored alert history. */
  historyNonce: number;
  bumpHistory: () => void;
}

const AdminSocketContext = createContext<AdminSocketValue | null>(null);

/**
 * Owns the single admin WebSocket for the tab, plus the refetch nonces.
 *
 * `useGridWebSocket` is per-instance, so calling it in a page under this
 * layout would open a second socket. Read from `useAdminSocket()` instead.
 */
export function GridSocketProvider({ children }: { children: React.ReactNode }) {
  const socket = useGridWebSocket({ clientType: "admin" });
  const [historyNonce, setHistoryNonce] = useState(0);
  const bumpHistory = useCallback(() => setHistoryNonce((n) => n + 1), []);

  // `socket` is a fresh object every render, so memoising on it buys nothing
  // on its own — but it keeps the identity stable across the renders where
  // only `historyNonce` moved, which is the common case.
  const value = useMemo<AdminSocketValue>(
    () => ({ ...socket, historyNonce, bumpHistory }),
    [socket, historyNonce, bumpHistory]
  );

  return (
    <AdminSocketContext.Provider value={value}>{children}</AdminSocketContext.Provider>
  );
}

/**
 * The shared admin socket. Throws rather than returning null so a component
 * rendered outside the admin layout fails loudly instead of quietly showing a
 * permanently disconnected dashboard.
 */
export function useAdminSocket(): AdminSocketValue {
  const ctx = useContext(AdminSocketContext);
  if (!ctx) {
    throw new Error("useAdminSocket must be used inside the admin layout's GridSocketProvider");
  }
  return ctx;
}
