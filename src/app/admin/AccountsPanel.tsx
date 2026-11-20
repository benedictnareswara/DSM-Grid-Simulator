"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  apiApproveUser,
  apiDeleteUser,
  apiListUsers,
  type MutationResult,
} from "@/hooks/useGridWebSocket";
import type { User } from "@/lib/types";
import { Notice } from "@/components/Notice";

/** Account management for the operator. */
export function AccountsPanel({ accountsNonce }: { accountsNonce: number }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsers(await apiListUsers());
    } catch {
      setError("Could not load accounts.");
    }
  }, []);

  // Written out rather than reusing refresh(): the React Compiler's set-state-in-effect rule cannot
  // see that refresh() only calls setState after an await, so calling it here reads as a
  // synchronous cascade.
  useEffect(() => {
    let cancelled = false;
    apiListUsers()
      .then((rows) => {
        if (!cancelled) setUsers(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load accounts.");
      });
    return () => {
      cancelled = true;
    };
  }, [accountsNonce]);

  const act = useCallback(
    async (user: User, fn: (id: string) => Promise<MutationResult>, verb: string) => {
      setBusyId(user.id);
      setError(null);
      setNotice(null);
      const res = await fn(user.id);
      // The HTTP status decides, not the shape of the body.
      if (!res.ok) {
        setError(res.message ?? `Could not ${verb} ${user.username} (HTTP ${res.status}).`);
      } else {
        setNotice(res.message ?? `${user.username} ${verb}d.`);
      }
      await refresh();
      setBusyId(null);
    },
    [refresh]
  );

  const pending = users?.filter((u) => u.status === "pending") ?? [];

  // Nothing waiting and nothing else to show — take the space back rather than standing an empty
  // card on the dashboard.
  if (users !== null && pending.length === 0 && !error && !notice) {
    return null;
  }

  return (
    <div className="ds-card ds-card--strip">
      {/*
          Header strip as the link — the body's Approve, Suspend and Delete rule out making the
          whole card one target.
      */}
      <Link href="/admin/accounts" className="ds-card__head">
        <span className="ds-card__title">Waiting for approval</span>
        <span className="ds-card__meta">
          <strong>
            {pending.length} {pending.length === 1 ? "household" : "households"}
          </strong>
          {" · Manage all →"}
        </span>
      </Link>

      <div className="ds-card__body">
        {error && <Notice tone="error" title={error} />}
        {notice && !error && <Notice>{notice}</Notice>}

        {users === null ? (
          <div className="ds-skeleton ds-skeleton--row" />
        ) : users.length === 0 ? (
          <div className="ds-empty">
            <strong>No accounts</strong>
            Nobody has registered yet.
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <>
                {pending.map((u) => (
                  <div key={u.id} className="ds-row">
                    <Link href={`/admin/accounts/${u.id}`} className="ds-link-strong">
                      {u.username}
                    </Link>
                    <span className="ds-row__mono">{u.email}</span>
                    <span className="ds-actions ds-actions--tight">
                      <button
                        className="ds-btn ds-btn--sm ds-btn--primary"
                        disabled={busyId === u.id}
                        onClick={() => act(u, apiApproveUser, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        className="ds-btn ds-btn--sm"
                        disabled={busyId === u.id}
                        onClick={() => setConfirmDelete(u)}
                      >
                        Reject
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}

          </>
        )}
      </div>

      {confirmDelete && (
        <div className="ds-modal" role="dialog" aria-modal="true">
          <div className="ds-modal__panel">
            <p className="ds-eyebrow">Delete account</p>
            <h2 className="ds-modal__title">{confirmDelete.username}</h2>
            <p>
              This removes the account and every response it ever gave. Tallies on past
              alerts will shrink. It cannot be undone — use <strong>Suspend</strong> if you
              only want to block sign-in.
            </p>
            <p className="ds-muted">
              The audit log keeps a record of the deletion, including the username.
            </p>
            <div className="ds-modal__actions">
              <button className="ds-btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="ds-btn ds-btn--danger"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  void act(target, apiDeleteUser, "delete");
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
