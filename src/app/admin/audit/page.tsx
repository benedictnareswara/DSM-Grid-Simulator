"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClearAudit, apiGetAudit } from "@/hooks/useGridWebSocket";
import type { AuditEntry } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { Pager } from "@/components/Pager";
import { fmt } from "@/lib/format";
import { FilterBar, FilterSelect } from "@/components/FilterBar";
import { Icon } from "@/components/Icon";
import { Notice } from "@/components/Notice";

const LIMIT = 50;

// Kept in step with the AUDIT verbs in src/server/db/schema.ts.
const ACTIONS = [
  ["", "Any action"],
  ["user.register", "Registered"],
  ["user.login", "Signed in"],
  ["user.approve", "Approved"],
  ["user.suspend", "Suspended"],
  ["user.reinstate", "Reinstated"],
  ["user.delete", "Deleted"],
  ["user.password_reset", "Password reset"],
  ["alert.push", "Alert pushed"],
  ["alert.ignore", "Alert ignored"],
  ["alert.respond", "Household answered"],
  ["simulation.control", "Run control"],
  ["simulation.reset", "Reset"],
  ["simulation.thresholds", "Thresholds retuned"],
  ["audit.clear", "Log cleared"],
];

/** The `detail` blob, as one readable line. */
function describeDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail) return "—";

  const { from, to } = detail as { from?: unknown; to?: unknown };
  if (isRecord(from) && isRecord(to)) {
    const changed = Object.keys(to)
      .filter((k) => from[k] !== to[k])
      .map((k) => `${k}: ${fmtValue(from[k])} → ${fmtValue(to[k])}`);
    return changed.length ? changed.join(" · ") : "no change";
  }

  return Object.entries(detail)
    .map(([k, v]) => `${k}=${fmtValue(v)}`)
    .join(" ");
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fmtValue = (v: unknown): string =>
  v === null || v === undefined
    ? "—"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);

export default function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a clear so the list refetches without a reload.
  const [clearNonce, setClearNonce] = useState(0);

  // Derived rather than set inside the effect — see the note on the alerts page.
  const query = `${offset}|${action}|${clearNonce}`;
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const loading = loadedQuery !== query;

  useEffect(() => {
    let cancelled = false;
    apiGetAudit({ limit: LIMIT, offset, action })
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setLoadedQuery(query);
      })
      .catch(() => {
        if (!cancelled) setLoadedQuery(query);
      });
    return () => {
      cancelled = true;
    };
  }, [query, offset, action]);

  async function clearLog() {
    setConfirmClear(false);
    setClearing(true);
    setError(null);
    setNotice(null);
    const res = await apiClearAudit();
    setClearing(false);
    if (res.ok) {
      setNotice(
        res.message
          ? `${res.message} They are hidden from this view, not deleted.`
          : "Log cleared. Entries are hidden from this view, not deleted."
      );
      setOffset(0);
      setClearNonce((n) => n + 1);
    } else {
      setError(res.message ?? `Could not clear the log (HTTP ${res.status}).`);
    }
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Audit log"
        subtitle="Who did what, including to accounts that no longer exist. Clearing hides entries; nothing here is ever deleted."
      />

      <FilterBar
        active={Boolean(action)}
        onClear={() => {
          setAction("");
          setOffset(0);
        }}
      >
        <FilterSelect
          value={action}
          onChange={(v) => {
            setAction(v);
            setOffset(0);
          }}
          choices={ACTIONS.map(([value, label]) => ({ value, label }))}
          label="Filter by action"
        />
        {/*
            Trailing, away from the filters — this is the one control here that changes the record
            rather than the view of it.
        */}
        <span className="ds-filters__trailing">
          <button
            className="ds-btn ds-btn--sm"
            onClick={() => setConfirmClear(true)}
            disabled={clearing || rows.length === 0}
            title="Hide every entry currently in the log. Nothing is deleted."
          >
            <Icon name="clear" size={15} />
            {clearing ? "Clearing…" : "Clear log"}
          </button>
        </span>
      </FilterBar>

      {error && <Notice tone="error" title={error} />}
      {notice && !error && <Notice>{notice}</Notice>}

      {loading ? (
        <div className="ds-skeleton ds-skeleton--table" />
      ) : rows.length === 0 ? (
        <div className="ds-card">
          <div className="ds-empty">
            <strong>Nothing recorded</strong>
            {action ? "No entries for that action." : "Operator actions will appear here."}
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="ds-table__mono">{fmt(a.created_at)}</td>
                  <td>
                    {a.actor_user_id ? (
                      <Link href={`/admin/accounts/${a.actor_user_id}`} className="ds-link-strong">
                        {a.actor_label}
                      </Link>
                    ) : (
                      // No actor means the system acted on its own — autopush, or an account's own
                      // registration before anyone existed to approve it.
                      <span className="ds-muted">{a.actor_label}</span>
                    )}
                  </td>
                  <td className="ds-table__mono">{a.action}</td>
                  <td>
                    {a.target_type === "user" && a.target_id ? (
                      <Link href={`/admin/accounts/${a.target_id}`}>{a.target_label}</Link>
                    ) : (
                      a.target_label ?? "—"
                    )}
                    {a.target_type && (
                      <div className="ds-muted">{a.target_type}</div>
                    )}
                  </td>
                  <td className="ds-table__mono">{describeDetail(a.detail)}</td>
                  <td className="ds-table__mono">{a.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager offset={offset} limit={LIMIT} count={rows.length} onChange={setOffset} />

      {confirmClear && (
        <div className="ds-modal" role="dialog" aria-modal="true">
          <div className="ds-modal__panel">
            <p className="ds-eyebrow">Clear audit log</p>
            <h2 className="ds-modal__title">Hide every entry</h2>
            <p className="ds-modal__body">
              This empties the log you are looking at. It does <strong>not</strong> delete
              anything — every row stays in the database, marked as cleared, and can still
              be read directly. Account pages will stop showing their history too.
            </p>
            <p className="ds-muted">
              The clear is itself recorded, so this page will not be empty: it will show
              one entry saying you cleared it, and how many entries were hidden.
            </p>
            <div className="ds-modal__actions">
              <button className="ds-btn" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
              <button className="ds-btn ds-btn--primary" onClick={clearLog}>
                Clear the log
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
