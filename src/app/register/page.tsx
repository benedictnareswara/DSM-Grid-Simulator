"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { AuthShell } from "@/components/AuthShell";
import { Notice } from "@/components/Notice";
import type { ApiError } from "@/lib/types";

/** Household self-registration. */
export default function RegisterPage() {
  const { register } = useAuth();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Mirrors USERNAME_RE in src/app/api/auth/register/route.ts.
  const usernameOk = /^[a-z0-9._-]{3,64}$/.test(username.trim().toLowerCase());
  const passwordsMatch = password.length > 0 && password === confirm;
  const canSubmit = usernameOk && email.includes("@") && password.length >= 8 && passwordsMatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const result = await register(username, email, password);
    if (result.success) setSubmitted(true);
    else setError(result.error ?? null);
    setIsSubmitting(false);
  };

  if (submitted) {
    return (
      <AuthShell subtitle="Create a household account. An operator approves it before alerts reach you.">
        <div className="ds-card ds-card--strip">
          <div className="ds-card__head">
            <span className="ds-card__title">Account created</span>
            <span className="ds-card__meta">pending</span>
          </div>
          <div className="ds-card__body ds-stack">
            <p>
              <strong>{username.trim().toLowerCase()}</strong> is registered but not yet
              active.
            </p>
            <p className="ds-muted">
              An operator has to approve it from the Accounts panel before you can sign in.
              Until then, signing in will tell you the account is waiting.
            </p>
            <Link href="/login" className="ds-btn ds-btn--primary ds-btn--block">
              Back to sign in
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Create a household account. An operator approves it before alerts reach you.">
      <div className="ds-card ds-card--strip">
        <div className="ds-card__head">
          <span className="ds-card__title">New household</span>
          <span className="ds-card__meta">role: consumer</span>
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
                  placeholder="budi"
                  autoComplete="username"
                  autoFocus
                  className="ds-input"
                />
                {username.length > 0 && !usernameOk && (
                  <span className="ds-field__hint">
                    3–64 characters: lowercase letters, digits, dot, dash, underscore.
                  </span>
                )}
              </label>

              <label className="ds-field">
                <span className="ds-field__label">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  placeholder="you@example.com"
                  autoComplete="email"
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
                  placeholder="at least 8 characters"
                  autoComplete="new-password"
                  className="ds-input"
                />
              </label>

              <label className="ds-field">
                <span className="ds-field__label">Confirm password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setError(null);
                  }}
                  autoComplete="new-password"
                  className="ds-input"
                />
                {confirm.length > 0 && !passwordsMatch && (
                  <span className="ds-field__hint">Passwords do not match.</span>
                )}
              </label>

          {error && <Notice tone="error" title={error.message} />}

          <button
            type="submit"
            className="ds-btn ds-btn--primary ds-btn--lg ds-btn--block"
            disabled={isSubmitting || !canSubmit}
          >
            {isSubmitting ? "Creating…" : "Create account"}
          </button>
        </form>
      </div>

      <p className="ds-auth__alt">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}
