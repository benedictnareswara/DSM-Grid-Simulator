"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

export default function Home() {
  const { isAuthenticated, role, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && role) {
      router.replace(role === "admin" ? "/admin" : "/consumer");
    } else {
      router.replace("/login");
    }
  }, [isLoading, isAuthenticated, role, router]);

  return (
    <div className="ds-page ds-page--center">
      <p className="ds-muted">Loading…</p>
    </div>
  );
}
