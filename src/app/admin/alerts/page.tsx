"use client";

import { useEffect, useState } from "react";
import { apiGetAlertHistory } from "@/hooks/useGridWebSocket";
import type { AlertOutcome, PersistedAlert } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { Pager } from "@/components/Pager";
import { fmt } from "@/lib/format";
import { FilterBar, FilterSelect, options } from "@/components/FilterBar";
import { SEVERITIES, PARAMETERS, OUTCOMES, DELIVERY_GRACE_MS } from "@/lib/constants";
import { useAdminSocket } from "../GridSocketProvider";

const LIMIT = 50;

/** How a persisted row's outcome reads in the table. */
const OUTCOME_LABEL: Record<AlertOutcome, { text: string; tone: string }> = {
  sending: { text: "sending…", tone: "ds-tag--sending" },
  pushed: { text: "delivered", tone: "ds-tag--ok" },
  "auto-pushed": { text: "auto-delivered", tone: "ds-tag--ok" },
  "failed-gateway": { text: "not delivered", tone: "ds-tag--bad" },
  ignored: { text: "ignored", tone: "" },
};

function OutcomeCell({ alert }: { alert: PersistedAlert }) {
  // null is pending — nobody has acted on it yet.
  if (!alert.outcome) return <span className="ds-tag">pending</span>;
  const { text, tone } = OUTCOME_LABEL[alert.outcome];
  return <span className={`ds-tag ${tone}`}>{text}</span>;
}

export default function AlertHistoryPage() {
  // Refetch when stored history moves (a push, a gateway delivery), so a row read mid-flight as
  // "sending…" settles here without a reload.
  const { historyNonce } = useAdminSocket();
  const [rows, setRows] = useState<PersistedAlert[]>([]);
  const [recheck, setRecheck] = useState(0);
  const [offset, setOffset] = useState(0);
  const [severity, setSeverity] = useState("");
  const [parameter, setParameter] = useState("");
  const [outcome, setOutcome] = useState("");

  // Loading is *derived*, not set at the top of the effect.
  const query = JSON.stringify({ offset, severity, parameter, outcome });
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const loading = loadedQuery !== query;

  useEffect(() => {
    let cancelled = false;
    apiGetAlertHistory({ limit: LIMIT, offset, severity, parameter, outcome })
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
  }, [query, offset, severity, parameter, outcome, historyNonce, recheck]);

  // A "sending…" row settles one way or the other within the grace window; nothing is broadcast
  // when the echo never comes, so look again just after.
  const awaitingEcho = rows.some((r) => r.outcome === "sending");
  useEffect(() => {
    if (!awaitingEcho) return;
    const t = setTimeout(() => setRecheck((n) => n + 1), DELIVERY_GRACE_MS + 1_000);
    return () => clearTimeout(t);
  }, [awaitingEcho, rows]);

  // Any filter change invalidates the current page number.
  function filter(setter: (v: string) => void, value: string) {
    setter(value);
    setOffset(0);
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Alert history"
        subtitle="Every alert the control logic triggered — pushed, dropped, ignored or pending"
      />

      <FilterBar
        active={Boolean(severity || parameter || outcome)}
        onClear={() => {
          setSeverity("");
          setParameter("");
          setOutcome("");
          setOffset(0);
        }}
      >
        <FilterSelect
          value={severity}
          onChange={(v) => filter(setSeverity, v)}
          choices={options(SEVERITIES, "Any severity")}
          label="Filter by severity"
        />
        <FilterSelect
          value={parameter}
          onChange={(v) => filter(setParameter, v)}
          choices={options(PARAMETERS, "Any parameter")}
          label="Filter by parameter"
        />
        <FilterSelect
          value={outcome}
          onChange={(v) => filter(setOutcome, v)}
          choices={OUTCOMES}
          label="Filter by outcome"
        />
      </FilterBar>

      {loading ? (
        <div className="ds-skeleton ds-skeleton--table" />
      ) : rows.length === 0 ? (
        <div className="ds-card">
          <div className="ds-empty">
            <strong>Nothing matches</strong>
            {severity || parameter || outcome
              ? "Try clearing the filters."
              : "Run the simulation to generate alerts."}
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Triggered</th>
                <th>Tick</th>
                <th>Severity</th>
                <th>Parameter</th>
                <th>Title</th>
                <th>Outcome</th>
                <th>Pushed by</th>
                <th className="ds-table__num">Tries</th>
                <th>Responses</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const accepted = a.responses.filter((r) => r.accepted).length;
                return (
                  <tr key={a.id}>
                    <td className="ds-table__mono">{fmt(a.triggered_at)}</td>
                    <td className="ds-table__num">{a.tick}</td>
                    <td>
                      <span className={`ds-sev ds-sev--${a.severity}`}>{a.severity}</span>
                    </td>
                    <td className="ds-table__mono">{a.parameter}</td>
                    <td>
                      <strong>{a.title}</strong>
                      <div className="ds-muted">{a.message}</div>
                    </td>
                    <td>
                      <OutcomeCell alert={a} />
                    </td>
                    <td className="ds-table__mono">
                      {a.auto_pushed ? "autopush" : a.pushed_by_username ?? "—"}
                    </td>
                    <td className="ds-table__num">{a.push_attempts}</td>
                    <td className="ds-table__mono">
                      {a.responses.length === 0
                        ? "—"
                        : `${a.responses.length} · ${accepted} yes`}
                      {a.responses.length > 0 && (
                        <div className="ds-muted">
                          {a.responses.map((r) => r.username).join(", ")}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager offset={offset} limit={LIMIT} count={rows.length} onChange={setOffset} />
    </div>
  );
}
