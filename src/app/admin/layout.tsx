"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { GridSocketProvider } from "./GridSocketProvider";
import { AdminSidebar } from "./AdminSidebar";

/**
 * The operator console's shell.
 *
 * Until now there was no layout here at all: every admin page composed its own
 * chrome by rendering `<AdminNav>`, so the nav re-mounted on each navigation
 * and nothing persisted between screens. The rail lives here instead, which is
 * what lets it hold live state and count badges that survive a route change.
 *
 * ## The guard is load-bearing
 *
 * `AdminNav` used to carry the admin route guard, and every page inherited it
 * purely as a side effect of rendering that component. Retiring `AdminNav`
 * therefore had to move the guard *first*, or `/admin/*` would have quietly
 * become reachable by any signed-in household.
 *
 * It is still a redirect rather than a render-block, for the reason the old
 * comment gave: these routes are admin-only at the API level too, so a
 * consumer who arrives sees empty tables, never data. The redirect is about
 * not stranding someone on a page that will never fill in.
 *
 * Note this does not render a spinner while `isLoading`. Blocking the whole
 * subtree on auth hydration would unmount and remount the socket provider on
 * every cold load, dropping and reopening the WebSocket for no reason.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, role, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && (!isAuthenticated || role !== "admin")) router.replace("/login");
  }, [isLoading, isAuthenticated, role, router]);

  return (
    <GridSocketProvider>
      <div className="ds-shell">
        <AdminSidebar />
        <main className="ds-shell__main">{children}</main>
      </div>
    </GridSocketProvider>
  );
}
