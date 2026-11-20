"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useGridWebSocket } from "@/hooks/useGridWebSocket";

/** One admin WebSocket per tab, shared by the shell and the page inside it. */

type GridSocket = ReturnType<typeof useGridWebSocket>;

interface AdminSocketValue extends GridSocket {
  /** Bumped by any operator action that changes stored alert history. */
  historyNonce: number;
  bumpHistory: () => void;
}

const AdminSocketContext = createContext<AdminSocketValue | null>(null);

/** Owns the single admin WebSocket for the tab, plus the refetch nonces. */
export function GridSocketProvider({ children }: { children: React.ReactNode }) {
  const socket = useGridWebSocket({ clientType: "admin" });
  const [localNonce, setLocalNonce] = useState(0);
  const bumpHistory = useCallback(() => setLocalNonce((n) => n + 1), []);
  // A gateway delivery changes stored history just as an operator action does, and everything that
  // refetches on `historyNonce` (the feed, the sidebar badges) has to hear about it.
  const historyNonce = localNonce + socket.deliveryNonce;

  // `socket` is a fresh object every render, so memoising on it buys nothing on its own — but it
  // keeps the identity stable across the renders where only `historyNonce` moved, which is the
  // common case.
  const value = useMemo<AdminSocketValue>(
    () => ({ ...socket, historyNonce, bumpHistory }),
    [socket, historyNonce, bumpHistory]
  );

  return (
    <AdminSocketContext.Provider value={value}>{children}</AdminSocketContext.Provider>
  );
}

/** The shared admin socket. */
export function useAdminSocket(): AdminSocketValue {
  const ctx = useContext(AdminSocketContext);
  if (!ctx) {
    throw new Error("useAdminSocket must be used inside the admin layout's GridSocketProvider");
  }
  return ctx;
}
