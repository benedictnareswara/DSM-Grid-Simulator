"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  apiGetUserProfile,
  apiSetUserPassword,
  apiApproveUser,
  apiSuspendUser,
  apiReinstateUser,
} from "@/hooks/useGridWebSocket";
import type { UserProfile } from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";
import { duration, idr, kwh } from "@/lib/domain";
import { PageHeader } from "@/components/PageHeader";
import { fmt } from "@/lib/format";
import { Notice } from "@/components/Notice";

/**
 * One household's full record.
 *
 * **There is no password here, and there cannot be.** Only a bcrypt hash is
 * stored, which is one-way — it cannot be turned back into the password, and
 * displaying the hash would put the one value worth protecting on screen while
 * telling the operator nothing they could act on. What replaces it is the reset
 * action below: replacement is the useful capability, not inspection.
 */
export default function AccountProfilePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { user: me } = useAuth();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [pw, setPw] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    apiGetUserProfile(id)
      .then((p) => {
        if (!cancelled) {
          setProfile(p);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  const act = useCallback(
    async (fn: (id: string) => Promise<{ ok: boolean; status: number; message?: string }>, verb: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      const res = await fn(id);
      if (!res.ok) setError(res.message ?? `Could not ${verb} (HTTP ${res.status}).`);
      else setNotice(res.message ?? `Account ${verb}d.`);
      setBusy(false);
      setNonce((n) => n + 1);
    },
    [id]
  );

  const submitPassword = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiSetUserPassword(id, pw);
    if (!res.ok) {
      setError(res.body?.detail?.message ?? `Could not set the password (HTTP ${res.status}).`);
    } else {
      setNotice(res.body?.message ?? "Password updated.");
      setPw("");
      setPwConfirm("");
    }
    setBusy(false);
    setNonce((n) => n + 1);
  }, [id, pw]);

  if (loading) {
    return (
      <div className="ds-page">
        <PageHeader title="Account" back={{ href: "/admin/accounts", label: "Accounts" }} />
        {/* A skeleton at the final shape, like every other admin page. The
            bare "Loading…" line this replaced collapsed the layout to one row
            and then snapped it back to a two-column grid of four cards. */}
        <div className="ds-grid ds-grid--2">
          <div className="ds-stack">
            <div className="ds-skeleton ds-skeleton--card" />
            <div className="ds-skeleton ds-skeleton--card" />
          </div>
          <div className="ds-stack">
            <div className="ds-skeleton ds-skeleton--card" />
            <div className="ds-skeleton ds-skeleton--card" />
          </div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="ds-page">
        <PageHeader title="Account" back={{ href: "/admin/accounts", label: "Accounts" }} />
        <div className="ds-card">
          <div className="ds-empty">
            <strong>No such account</strong>
            It may have been deleted. <Link href="/admin/accounts">Back to accounts</Link>
          </div>
        </div>
      </div>
    );
  }

  const u = profile.user;
  const isSelf = u.id === me?.id;
  const pwValid = pw.length >= 8 && pw === pwConfirm;

  return (
    <div className="ds-page">
      <PageHeader
        title={u.username}
        subtitle={`${u.role} · ${u.status}`}
        back={{ href: "/admin/accounts", label: "Accounts" }}
      />

      {error && <Notice tone="error" title={error} />}
      {notice && !error && <Notice>{notice}</Notice>}

      <div className="ds-grid ds-grid--2">
        <div className="ds-stack">
          {/* ── Profile ── */}
          <div className="ds-card ds-card--strip">
            {/* No status chip here: PageHeader's subtitle prints `role · status`
                about 30px above this strip, and the definition list below
                prints it a third time. One of the three is enough. */}
            <div className="ds-card__head">
              <span className="ds-card__title">Profile</span>
            </div>
            <div className="ds-card__body">
              <dl className="ds-dl">
                <dt>Username</dt>
                <dd>{u.username}</dd>
                <dt>Email</dt>
                <dd>{u.email}</dd>
                <dt>Role</dt>
                <dd>{u.role}</dd>
                <dt>Status</dt>
                <dd>{u.status}</dd>
                <dt>Registered</dt>
                <dd>{fmt(u.created_at)}</dd>
                <dt>Approved</dt>
                <dd>
                  {fmt(u.approved_at)}
                  {u.approved_by_username && ` by ${u.approved_by_username}`}
                </dd>
                <dt>Last sign-in</dt>
                <dd>{fmt(u.last_login_at)}</dd>
                <dt>Password</dt>
                <dd className="ds-muted">
                  Stored as a bcrypt hash — one-way, so it cannot be shown or recovered.
                  Use Reset below.
                </dd>
              </dl>

              <div className="ds-actions">
                {u.status === "pending" && (
                  <button
                    className="ds-btn ds-btn--sm ds-btn--primary"
                    disabled={busy}
                    onClick={() => act(apiApproveUser, "approve")}
                  >
                    Approve
                  </button>
                )}
                {u.status === "suspended" ? (
                  <button
                    className="ds-btn ds-btn--sm"
                    disabled={busy}
                    onClick={() => act(apiReinstateUser, "reinstate")}
                  >
                    Reinstate
                  </button>
                ) : (
                  <button
                    className="ds-btn ds-btn--sm"
                    disabled={busy || isSelf}
                    title={isSelf ? "You cannot suspend your own account" : undefined}
                    onClick={() => act(apiSuspendUser, "suspend")}
                  >
                    Suspend
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Password reset ── */}
          <div className="ds-card ds-card--strip">
            <div className="ds-card__head">
              <span className="ds-card__title">Reset password</span>
              <span className="ds-card__meta">signs them out</span>
            </div>
            <div className="ds-card__body ds-stack">
              <p className="ds-muted">
                Sets a new password for <strong>{u.username}</strong> and revokes every
                session they have open. Tell them the new password yourself — it is not
                shown again and is never written to the audit log.
              </p>
              <label className="ds-field">
                <span className="ds-field__label">New password</span>
                <input
                  type="password"
                  className="ds-input"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="at least 8 characters"
                  autoComplete="new-password"
                />
              </label>
              <label className="ds-field">
                <span className="ds-field__label">Confirm</span>
                <input
                  type="password"
                  className="ds-input"
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  autoComplete="new-password"
                />
                {pwConfirm.length > 0 && pw !== pwConfirm && (
                  <span className="ds-field__hint">Passwords do not match.</span>
                )}
              </label>
              <button
                className="ds-btn ds-btn--danger"
                disabled={busy || !pwValid}
                onClick={submitPassword}
              >
                Set password
              </button>
            </div>
          </div>
        </div>

        <div className="ds-stack">
          {/* ── Participation ── */}
          <div className="ds-card ds-card--strip">
            <div className="ds-card__head">
              <span className="ds-card__title">Participation</span>
              <span className="ds-card__meta">
                {profile.accepted_count} accepted · {profile.declined_count} declined
              </span>
            </div>
            <div className="ds-card__body">
              {/* Can this household be counted on? Accept rate alone does not
                  answer it — an operator shedding load in a contingency needs
                  to know whether the yes arrives in time to matter, which is
                  why the score weighs speed alongside willingness. */}
              <div className="ds-row">
                <span>Reliability</span>
                <span className="ds-muted">
                  {Math.round((profile.accept_rate ?? 0) * 100)}% accepted
                  {profile.median_latency_seconds != null &&
                    ` · ${duration(profile.median_latency_seconds)} median reply`}
                </span>
                <ScoreBadge score={profile.reliability_score ?? 0} />
              </div>
              <div className="ds-row">
                <span>Energy shifted</span>
                <span className="ds-row__mono">{kwh(profile.total_kwh ?? 0)} kWh</span>
              </div>
              <div className="ds-row">
                <span>Estimated credit</span>
                <span className="ds-row__mono">Rp {idr(profile.estimated_credit_idr)}</span>
              </div>
              <div className="ds-row ds-row--last">
                <span>Current streak</span>
                <span className="ds-row__mono">
                  {profile.current_streak
                    ? `${profile.current_streak} in a row`
                    : "not on a streak"}
                </span>
              </div>

              {/* The list below had no heading, so it read as four more summary
                  rows rather than as individual answers. */}
              <p className="ds-eyebrow ds-eyebrow--spaced">Recent answers</p>

              {profile.recent_responses.length === 0 ? (
                <div className="ds-empty">
                  <strong>No responses yet</strong>
                  This household has not answered an alert.
                </div>
              ) : (
                profile.recent_responses.map((r) => (
                  <div key={r.id} className="ds-row">
                    <span>{r.alert_title}</span>
                    <span
                      className={`ds-badge ${
                        r.accepted ? "ds-badge--accepted" : "ds-badge--declined"
                      }`}
                    >
                      {r.accepted ? "Accepted" : "Declined"}
                    </span>
                    <span className="ds-row__mono">
                      {r.accepted && r.credit_idr ? `Rp ${idr(r.credit_idr)}` : "—"}
                    </span>
                    <span className="ds-row__mono">
                      {r.latency_seconds != null ? duration(r.latency_seconds) : "—"}
                    </span>
                    <span className="ds-row__mono">{fmt(r.responded_at)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ── Audit trail ── */}
          <div className="ds-card ds-card--strip ds-card--scroll">
            <div className="ds-card__head">
              <span className="ds-card__title">Audit trail</span>
              <span className="ds-card__meta">{profile.recent_audit.length} entries</span>
            </div>
            <div className="ds-card__body">
              {profile.recent_audit.length === 0 ? (
                <div className="ds-empty">
                  <strong>Nothing recorded</strong>
                  Actions on this account will appear here.
                </div>
              ) : (
                profile.recent_audit.map((a) => (
                  <div key={a.id} className="ds-row">
                    <span className="ds-row__mono">{a.action}</span>
                    <span className="ds-muted">
                      {/* Who did it — "system" when nobody was signed in, e.g.
                          the account's own registration. */}
                      {a.actor_label}
                    </span>
                    <span className="ds-row__mono">{fmt(a.created_at)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Reliability as a chip, in three bands.
 *
 * Banded rather than a continuous scale because the operator is making a
 * three-way call — lean on them, expect them, don't count on them — not
 * reading a ranking to two significant figures.
 */
function ScoreBadge({ score }: { score: number }) {
  const band = score >= 70 ? "high" : score >= 40 ? "" : "low";
  return (
    <span
      className={`ds-score ${band ? `ds-score--${band}` : ""}`}
      title="From accept rate (70%) and median reply speed (30%). Operator-facing only."
    >
      {score}
      <span className="ds-score__unit">/100</span>
    </span>
  );
}
