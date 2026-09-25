"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  apiListUsers,
  apiApproveUser,
  apiSuspendUser,
  apiReinstateUser,
  type MutationResult,
} from "@/hooks/useGridWebSocket";
import type { User, UserStatus } from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";
import { PageHeader } from "@/components/PageHeader";
import { Pager } from "@/components/Pager";
import { fmt } from "@/lib/format";
import { Notice } from "@/components/Notice";
import { FilterBar, FilterSelect, options } from "@/components/FilterBar";

const STATUSES: (UserStatus | "")[] = ["", "pending", "active", "suspended"];
const LIMIT = 50;

/**
 * Every account, and the actions on them.
 *
 * This page used to be read-only, with a banner telling the operator to go
 * back to the dashboard to actually do anything — so the list and the actions
 * on that list lived on two different screens. It was also the only table in
 * the section without a pager.
 *
 * Delete is deliberately *not* here: it cascades a household's whole response
 * history away and is not reversible, so it stays on the account's own page
 * where there is room to say so. Approve, Suspend and Reinstate are all one
 * click to undo.
 */
export default function AccountsPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [status, setStatus] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiListUsers()
      .then((r) => {
        if (!cancelled) setUsers(r);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const act = useCallback(
    async (u: User, fn: (id: string) => Promise<MutationResult>, verb: string) => {
      setBusyId(u.id);
      setError(null);
      setNotice(null);
      const res = await fn(u.id);
      // The HTTP status decides, not the shape of the body.
      if (!res.ok) {
        setError(res.message ?? `Could not ${verb} ${u.username} (HTTP ${res.status}).`);
      } else {
        setNotice(res.message ?? `${u.username} ${verb}d.`);
      }
      setBusyId(null);
      setNonce((n) => n + 1);
    },
    []
  );

  const matching = (users ?? []).filter((u) => !status || u.status === status);
  const shown = matching.slice(offset, offset + LIMIT);
  const pending = (users ?? []).filter((u) => u.status === "pending").length;

  return (
    <div className="ds-page">
      <PageHeader
        title="Accounts"
        subtitle="Every registered household and operator"
      />

      {pending > 0 && (
        <Notice
          tone="pending"
          title={`${pending} ${pending === 1 ? "account is" : "accounts are"} waiting for approval.`}
        >
          They cannot sign in until you approve them. Use the Approve button on their row.
        </Notice>
      )}

      {error && <Notice tone="error" title={error} />}
      {notice && !error && <Notice>{notice}</Notice>}

      <FilterBar
        active={Boolean(status)}
        onClear={() => {
          setStatus("");
          setOffset(0);
        }}
        trailing={`${matching.length} matching`}
      >
        <FilterSelect
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          choices={options(STATUSES, "Any status")}
          label="Filter by status"
        />
      </FilterBar>

      {users === null ? (
        <div className="ds-skeleton ds-skeleton--table" />
      ) : shown.length === 0 ? (
        <div className="ds-card">
          <div className="ds-empty">
            <strong>No accounts</strong>
            {status ? "Nothing with that status." : "Nobody has registered yet."}
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Registered</th>
                <th>Approved</th>
                <th>Last sign-in</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/admin/accounts/${u.id}`} className="ds-link-strong">
                      {u.username}
                    </Link>
                  </td>
                  <td className="ds-table__mono">{u.email}</td>
                  <td className="ds-table__mono">{u.role}</td>
                  <td>
                    <span
                      className={`ds-badge ${
                        u.status === "active"
                          ? "ds-badge--accepted"
                          : u.status === "pending"
                            ? ""
                            : "ds-badge--declined"
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="ds-table__mono">{fmt(u.created_at)}</td>
                  <td className="ds-table__mono">
                    {fmt(u.approved_at)}
                    {u.approved_by_username && (
                      <div className="ds-muted">by {u.approved_by_username}</div>
                    )}
                  </td>
                  <td className="ds-table__mono">{fmt(u.last_login_at)}</td>
                  <td>
                    <span className="ds-actions ds-actions--tight">
                      {u.status === "pending" && (
                        <button
                          className="ds-btn ds-btn--sm ds-btn--primary"
                          disabled={busyId === u.id}
                          onClick={() => act(u, apiApproveUser, "approve")}
                        >
                          Approve
                        </button>
                      )}
                      {u.status === "suspended" ? (
                        <button
                          className="ds-btn ds-btn--sm"
                          disabled={busyId === u.id}
                          onClick={() => act(u, apiReinstateUser, "reinstate")}
                        >
                          Reinstate
                        </button>
                      ) : (
                        <button
                          className="ds-btn ds-btn--sm"
                          // Disabled rather than hidden: the backend refuses it
                          // anyway, and a button that vanishes is more confusing
                          // than one that is visibly unavailable.
                          disabled={busyId === u.id || u.id === me?.id}
                          title={
                            u.id === me?.id ? "You cannot suspend your own account" : undefined
                          }
                          onClick={() => act(u, apiSuspendUser, "suspend")}
                        >
                          Suspend
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager offset={offset} limit={LIMIT} count={shown.length} onChange={setOffset} />
    </div>
  );
}
