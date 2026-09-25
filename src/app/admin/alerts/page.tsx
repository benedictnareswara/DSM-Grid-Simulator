"use client";

import { useEffect, useState } from "react";
import { apiGetAlertHistory } from "@/hooks/useGridWebSocket";
import type { AlertOutcome, PersistedAlert } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { Pager } from "@/components/Pager";
import { fmt } from "@/lib/format";
import { FilterBar, FilterSelect, options } from "@/components/FilterBar";
import { SEVERITIES, PARAMETERS, OUTCOMES } from "@/lib/constants";

const LIMIT = 50;

/** How an alert's state reads in the table, with the colour matching severity. */
/**
 * How a persisted row reads in the table.
 *
 * Switches on the server's `outcome`, which `Alert.outcome` in
 * the server (`alertOutcome`) derives from `ignored_at` / `delivered_at` /
 * `pushed_at`. This used to re-derive it here from those same three
 * timestamps — the same rule, written twice, in two languages, which is the
 * duplication `AlertOutcome`'s own doc comment warns about.
 *
 * The words differ from the live feed's on purpose: a column says
 * "delivered", the feed says "delivered to gateway", because an operator
 * watching the feed is watching the gateway. The *classification* is what
 * must not be restated.
 */
const OUTCOME_LABEL: Record<AlertOutcome, { text: string; tone: string }> = {
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
  const [rows, setRows] = useState<PersistedAlert[]>([]);
  const [offset, setOffset] = useState(0);
  const [severity, setSeverity] = useState("");
  const [parameter, setParameter] = useState("");
  const [outcome, setOutcome] = useState("");

  // Loading is *derived*, not set at the top of the effect. Calling setState
  // synchronously in an effect body triggers a cascading render, which the
  // React Compiler rejects; comparing the request we want against the one we
  // already have says the same thing with no extra pass.
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
  }, [query, offset, severity, parameter, outcome]);

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
