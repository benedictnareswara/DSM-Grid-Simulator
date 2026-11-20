"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { AuthShell } from "@/components/AuthShell";
import { Notice } from "@/components/Notice";
import type { ApiError } from "@/lib/types";

export default function LoginPage() {
  const { isAuthenticated, role, login, isLoading } = useAuth();
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // If already logged in, redirect to dashboard
  useEffect(() => {
    if (!isLoading && isAuthenticated && role) {
      router.push(role === "admin" ? "/admin" : "/consumer");
    }
  }, [isLoading, isAuthenticated, role, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    // No artificial delay any more — this is a real network round trip that includes a bcrypt
    // verify, so it takes as long as it takes.
    const result = await login(username, password);
    if (!result.success) setError(result.error ?? null);
    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <div className="ds-page ds-page--center">
        <div className="ds-auth">
          <div className="ds-skeleton ds-skeleton--title" />
          <div className="ds-skeleton ds-skeleton--card" />
        </div>
      </div>
    );
  }

  if (isAuthenticated) return null;

  // "Waiting for approval" is not a failed login and should not read like one.
  const isPending = error?.code === "account_pending";

  return (
    <AuthShell subtitle="Indonesian PLN Grid · 220V / 50Hz · Neighborhood Scale">
      <div className="ds-card ds-card--strip">
        <div className="ds-card__head">
          <span className="ds-card__title">Sign in</span>
        </div>

        <form className="ds-card__body ds-stack" onSubmit={handleSubmit}>
          <label className="ds-field">
            <span className="ds-field__label">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              placeholder="username"
              autoComplete="username"
              autoFocus
              className="ds-input"
            />
          </label>

          <label className="ds-field">
            <span className="ds-field__label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              placeholder="••••••••"
              autoComplete="current-password"
              className="ds-input"
            />
          </label>

          {error &&
            (isPending ? (
              <Notice tone="pending" title="Waiting for approval">
                Your account exists but an operator has to approve it before you can sign
                in. Ask them to open the Accounts panel.
              </Notice>
            ) : (
              <Notice tone="error" title={error.message} />
            ))}

          <button
            type="submit"
            className="ds-btn ds-btn--primary ds-btn--lg ds-btn--block"
            disabled={isSubmitting || !username || !password}
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>

      <p className="ds-auth__alt">
        Households can register here — an operator approves each new account.{" "}
        <Link href="/register">Create an account</Link>
      </p>
    </AuthShell>
  );
}
