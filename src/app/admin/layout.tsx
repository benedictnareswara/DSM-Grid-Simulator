"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { GridSocketProvider } from "./GridSocketProvider";
import { AdminSidebar } from "./AdminSidebar";

/** The operator console's shell. */
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
