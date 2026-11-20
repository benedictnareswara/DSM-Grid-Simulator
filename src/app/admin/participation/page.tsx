"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  apiGetParticipation,
  apiGetParticipationCount,
  apiGetSavings,
} from "@/hooks/useGridWebSocket";
import type { ParticipationEntry, SavingsSummary } from "@/lib/types";
import { duration, idr, kwh, multiplier } from "@/lib/domain";
import { PageHeader } from "@/components/PageHeader";
import { Pager } from "@/components/Pager";
import { fmt } from "@/lib/format";
import { FilterBar, FilterSelect, options } from "@/components/FilterBar";
import { Metric } from "@/components/Metric";
import { SEVERITIES, PARAMETERS, PARAMETER_LABELS } from "@/lib/constants";

const LIMIT = 50;

const ANSWERS = [
  ["", "Any answer"],
  ["true", "Accepted"],
  ["false", "Declined"],
];

/**
 * Credit, latency and the two multipliers all arrive computed on the row —
 * `src/server/grid/incentives.ts` owns that arithmetic now.
 */
const creditOf = (r: ParticipationEntry) => r.credit_idr ?? 0;

export default function ParticipationPage() {
  const [rows, setRows] = useState<ParticipationEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [household, setHousehold] = useState("");
  const [answer, setAnswer] = useState("");
  const [severity, setSeverity] = useState("");
  const [parameter, setParameter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savings, setSavings] = useState<SavingsSummary | null>(null);

  // Programme-wide and unfiltered — /api/savings takes no filter parameters, so it is fetched once
  // rather than with the query below.
  useEffect(() => {
    let cancelled = false;
    apiGetSavings()
      .then((s) => {
        if (!cancelled) setSavings(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Derived rather than set inside the effect — see the note on the alerts page.
  const query = JSON.stringify({ offset, answer, severity, parameter });
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const loading = loadedQuery !== query;

  useEffect(() => {
    let cancelled = false;
    // `accepted` has to be undefined rather than "" for "either", because `false` is a meaningful
    // value the query serialiser must not drop.
    const filters = {
      accepted: answer === "" ? undefined : answer === "true",
      severity,
      parameter,
    };
    Promise.all([
      apiGetParticipation({ limit: LIMIT, offset, ...filters }),
      apiGetParticipationCount(filters),
    ])
      .then(([r, count]) => {
        if (cancelled) return;
        setRows(r);
        setTotal(count);
        setLoadedQuery(query);
      })
      .catch(() => {
        if (!cancelled) setLoadedQuery(query);
      });
    return () => {
      cancelled = true;
    };
  }, [query, offset, answer, severity, parameter]);

  // Household stays a client-side filter: the page is already bounded to LIMIT rows and a round
  // trip per keystroke would be slower than filtering what is on screen.
  const shown = household
    ? rows.filter((r) => r.username.toLowerCase().includes(household.toLowerCase()))
    : rows;

  const accepted = shown.filter((r) => r.accepted).length;
  const credit = shown.reduce((sum, r) => sum + creditOf(r), 0);
  const savedKwh = shown.reduce(
    (sum, r) => sum + (r.accepted ? r.expected_shed_kwh ?? 0 : 0),
    0
  );
  const households = new Set(shown.map((r) => r.username)).size;
  const latencies = shown
    .map((r) => r.latency_seconds)
    .filter((v): v is number => v !== null && v !== undefined);
  const median =
    latencies.length === 0
      ? null
      : [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)];

  const filtered = Boolean(answer || severity || parameter || household);

  function filter(setter: (v: string) => void, value: string) {
    setter(value);
    setOffset(0);
    setExpanded(null);
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Participation log"
        subtitle="Every household answer, attributed — one vote per household per alert"
      />

      <FilterBar
        active={filtered}
        onClear={() => {
          setHousehold("");
          setAnswer("");
          setSeverity("");
          setParameter("");
          setOffset(0);
          setExpanded(null);
        }}
      >
        <input
          className="ds-input ds-input--inline"
          placeholder="Filter by household…"
          value={household}
          onChange={(e) => filter(setHousehold, e.target.value)}
          aria-label="Filter by household"
        />
        <FilterSelect
          value={answer}
          onChange={(v) => filter(setAnswer, v)}
          choices={ANSWERS.map(([value, label]) => ({ value, label }))}
          label="Filter by answer"
        />
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
      </FilterBar>

      {/* The page's own numbers, as figures rather than one run-on sentence of eight. */}
      <div className="ds-metrics">
        <Metric
          label="Matching"
          value={total === null ? "—" : total.toLocaleString()}
          sub={`${shown.length} on this page`}
        />
        <Metric
          label="Accepted"
          value={accepted.toLocaleString()}
          sub={`${shown.length - accepted} declined`}
        />
        <Metric
          label="Households"
          value={households.toLocaleString()}
          sub={median !== null ? `${duration(median)} median reply` : "no reply times"}
        />
        <Metric label="Energy shifted" value={`${kwh(savedKwh)} kWh`} sub="on this page" />
        <Metric label="Credit" value={`Rp ${idr(credit)}`} sub="on this page" />
      </div>

      {/* Where the programme's load is actually coming from. */}
      {savings && savings.accepted_count > 0 && (
        <div className="ds-card ds-card--strip">
          <div className="ds-card__head">
            <span className="ds-card__title">By grid condition</span>
            <span className="ds-card__meta">
              whole programme · {kwh(savings.total_kwh)} kWh · Rp{" "}
              {idr(savings.total_credit_idr)}
            </span>
          </div>
          <div className="ds-card__body">
            {savings.by_parameter.map((b) => (
              <div key={b.key} className="ds-row">
                <span>{PARAMETER_LABELS[b.key] ?? b.key}</span>
                <span className="ds-muted">
                  {b.responses} {b.responses === 1 ? "accept" : "accepts"}
                </span>
                <span className="ds-row__mono">
                  {kwh(b.kwh)} kWh · Rp {idr(b.credit_idr)}
                </span>
              </div>
            ))}
            {/* Modelled, not metered. */}
            <p className="ds-muted ds-muted--xs ds-eyebrow--spaced">
              Modelled from what each alert asked for, not metered. See
              docs/ARCHITECTURE.md.
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="ds-skeleton ds-skeleton--table" />
      ) : shown.length === 0 ? (
        <div className="ds-card">
          <div className="ds-empty">
            <strong>No responses</strong>
            {filtered
              ? "Nothing matches those filters."
              : "Push an alert and wait for a household to answer."}
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Answered</th>
                <th>Household</th>
                <th>Answer</th>
                <th className="ds-table__num">Replied in</th>
                {/*
                    Severity rides inside this cell rather than owning a column: it is the fastest
                    thing to scan for, so it stays visible, but it is one chip and does not need
                    90px of header.
                */}
                <th>Alert</th>
                <th className="ds-table__num">kWh</th>
                <th className="ds-table__num">Credit</th>
                <th>History</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const open = expanded === r.id;
                return (
                  <Row
                    key={r.id}
                    entry={r}
                    open={open}
                    onToggle={() => setExpanded(open ? null : r.id)}
                  />
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

/** One answer, with the alert's lifecycle folded away behind a disclosure. */
function Row({
  entry,
  open,
  onToggle,
}: {
  entry: ParticipationEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const credit = creditOf(entry);
  const latency = entry.latency_seconds ?? null;
  return (
    <>
      <tr>
        <td className="ds-table__mono">{fmt(entry.responded_at)}</td>
        <td>
          <Link href={`/admin/accounts/${entry.user_id}`} className="ds-link-strong">
            {entry.username}
          </Link>
        </td>
        <td>
          <span
            className={`ds-badge ${entry.accepted ? "ds-badge--accepted" : "ds-badge--declined"}`}
          >
            {entry.accepted ? "Accepted" : "Declined"}
          </span>
        </td>
        <td className="ds-table__num" title="Measured from the gateway delivering the alert">
          {latency === null ? "—" : duration(latency)}
          {/* Why this row was paid more, next to the reason it was. */}
          {entry.accepted && entry.response_bonus_label && (
            <div className="ds-muted ds-muted--xs">
              {multiplier(entry.response_bonus)} speed
            </div>
          )}
        </td>
        <td>
          <span className="ds-cellstack">
            <span className={`ds-sev ds-sev--${entry.alert_severity}`}>
              {entry.alert_severity}
            </span>
            {entry.alert_title}
          </span>
        </td>
        <td className="ds-table__num">
          {entry.accepted ? kwh(entry.expected_shed_kwh ?? 0) : "—"}
        </td>
        <td className="ds-table__num">
          {credit > 0 ? `Rp ${idr(credit)}` : "—"}
          {entry.accepted && (entry.streak_at_response ?? 0) > 1 && (
            <div className="ds-muted ds-muted--xs">
              {multiplier(entry.streak_multiplier)} · {entry.streak_at_response} in a row
            </div>
          )}
        </td>
        <td>
          <button
            className="ds-disclosure"
            aria-expanded={open}
            onClick={onToggle}
            title="Show how this alert reached the household"
          >
            <span className="ds-disclosure__caret" aria-hidden="true">
              ▸
            </span>
            {open ? "Hide" : "Trace"}
          </button>
        </td>
      </tr>

      {open && (
        <tr className="ds-table__detail">
          <td colSpan={8}>
            <p className="ds-eyebrow">What the household was asked</p>
            <p className="ds-muted">{entry.alert_message || "—"}</p>
            {entry.alert_incentive && (
              <p className="ds-muted">Incentive: {entry.alert_incentive}</p>
            )}
            {/*
                The two columns this table gave up, kept where they are still answerable rather than
                dropped.
            */}
            <p className="ds-muted ds-muted--xs">
              {entry.alert_parameter} · tick {entry.tick.toLocaleString()}
            </p>

            {/* The credit, factor by factor. */}
            {entry.accepted && (
              <>
                <p className="ds-eyebrow ds-eyebrow--spaced">
                  How the credit was worked out
                </p>
                <div className="ds-steps">
                  <Step
                    label="Rate"
                    value={
                      entry.reward_idr_per_kwh
                        ? `Rp ${idr(entry.reward_idr_per_kwh)}/kWh`
                        : "—"
                    }
                    note="set by which parameter fired"
                  />
                  <Step
                    label="Asked for"
                    value={`${kwh(entry.expected_shed_kwh ?? 0)} kWh`}
                    note="by parameter and severity"
                  />
                  <Step
                    label="Speed"
                    value={multiplier(entry.response_bonus) || "1×"}
                    note={entry.response_bonus_label ?? "no speed bonus"}
                  />
                  <Step
                    label="Streak"
                    value={multiplier(entry.streak_multiplier) || "1×"}
                    note={
                      (entry.streak_at_response ?? 0) > 1
                        ? `${entry.streak_at_response} accepts in a row`
                        : "first accept in this run"
                    }
                  />
                  <Step
                    label="Credit"
                    value={`Rp ${idr(entry.credit_idr ?? 0)}`}
                    note="estimate, not a billed figure"
                  />
                </div>
              </>
            )}

            <p className="ds-eyebrow ds-eyebrow--spaced">
              How it got there
            </p>
            <div className="ds-steps">
              <Step label="Triggered" value={fmt(entry.triggered_at)} />
              <Step
                label={entry.auto_pushed ? "Auto-pushed" : "Pushed"}
                value={fmt(entry.pushed_at)}
                // No name on an autopush because no operator was involved.
                note={
                  entry.auto_pushed
                    ? "by autopush"
                    : entry.pushed_by_username
                      ? `by ${entry.pushed_by_username}`
                      : undefined
                }
              />
              <Step
                label="Delivered by gateway"
                value={fmt(entry.delivered_at)}
                note={
                  entry.delivered_at
                    ? undefined
                    : "no delivery stamp — this answer predates the gateway echo"
                }
              />
              <Step
                label="Answered"
                value={fmt(entry.responded_at)}
                note={entry.accepted ? "accepted" : "declined"}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** One box in the lifecycle. Rendered even when empty — a gap is information. */
function Step({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  const absent = value === "—";
  return (
    <div className={`ds-step ${absent ? "ds-step--absent" : ""}`}>
      <div className="ds-step__label">{label}</div>
      <div className="ds-step__value">{value}</div>
      {note && <div className="ds-muted ds-muted--xs">{note}</div>}
    </div>
  );
}
