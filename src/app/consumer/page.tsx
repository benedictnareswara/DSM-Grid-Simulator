"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  useGridWebSocket,
  playAlertSound,
  apiRespondToAlert,
  apiGetMyAlertHistory,
  apiGetMySavings,
  apiGetIncentiveModel,
} from "@/hooks/useGridWebSocket";
import { useAlertNotifications } from "@/hooks/useAlertNotifications";
import { useAuth } from "@/hooks/useAuth";
import {
  PARAMETER_ASKS,
  DEFAULT_PARAMETER_ASK,
  type DSMAlert,
  type AlertLogEntry,
  type PersistedAlert,
  type SavingsSummary,
  type IncentiveModel,
} from "@/lib/types";
// The credit model lives on the backend now. This page used to declare its own
// ASSUMED_REDUCTION_KWH and multiply — one of four copies that agreed only by
// coincidence. See frontend/lib/domain.ts.
import {
  capturedFraction,
  estimatedCredit,
  getVerdict,
  idr,
  kwh,
  multiplier,
  shedKwh,
  throttleLine,
  topSpeedBonus,
} from "@/lib/domain";
import { Metric } from "@/components/Metric";
import { Notice } from "@/components/Notice";
import { Icon, type IconName } from "@/components/Icon";

type Decision = { action: "accepted" | "declined"; actionAt: string };

/**
 * A persisted alert, back in the shape the UI already renders.
 *
 * The two differ only because the database row also records delivery and
 * authorship, which the live `pushed_alert` payload has no need to carry.
 */
function fromPersisted(row: PersistedAlert): DSMAlert {
  return {
    id: row.alert_id,
    tick: row.tick,
    timestamp: row.timestamp,
    severity: row.severity,
    parameter: row.parameter,
    title: row.title,
    message: row.message,
    incentive: row.incentive ?? undefined,
    value: row.value,
    threshold: row.threshold,
    reward_idr_per_kwh: row.reward_idr_per_kwh,
    // Must be copied, or a *restored* alert loses what it asks for and the
    // pre-answer preview reads "no bill credit applies to this alert" for one
    // worth thousands of rupiah. Live socket arrivals carry it; history has to
    // be given it explicitly. Same trap for the throttle pair below — omit
    // them and the setpoint silently disappears on reload.
    expected_shed_kwh: row.expected_shed_kwh,
    duration_minutes: row.duration_minutes,
    target_reduction_w: row.target_reduction_w,
    auto_push_status: row.auto_pushed ? "sent" : null,
  };
}

/**
 * Grid conditions in household language, for the savings breakdown. The raw
 * `parameter` values ("reserve_margin", "peak_load") are the operator's
 * vocabulary and mean nothing on a phone.
 */
const PARAMETER_LABELS: Record<string, string> = {
  peak_load: "Peak demand",
  frequency: "Grid frequency",
  reserve_margin: "Low spare capacity",
  renewable: "Low clean energy",
  emergency: "Grid emergency",
  price: "Price spikes",
};

type Tab = "alerts" | "now" | "savings";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "alerts", label: "Alerts", icon: "alerts" },
  { id: "now", label: "Now", icon: "now" },
  { id: "savings", label: "Savings", icon: "savings" },
];

export default function ConsumerApp() {
  const { isAuthenticated, role, logout, isLoading } = useAuth();
  const router = useRouter();

  // ALL hooks called unconditionally
  const {
    connected,
    gridState,
    pushedAlerts,
    esp32Connected,
    authFailed,
    resetNonce,
    // Answers this household gave on another device, echoed back through the
    // gateway. Without it a laptop tab and a phone disagreed about what had
    // been answered until one of them was reloaded.
    remoteDecisions,
  } = useGridWebSocket({
    clientType: "consumer",
    maxAlerts: 100,
  });
  const notifications = useAlertNotifications();

  // The socket was rejected and could not be refreshed — this household was
  // suspended or deleted while the app was open.
  useEffect(() => {
    if (authFailed) router.replace("/login");
  }, [authFailed, router]);

  const [tab, setTab] = useState<Tab>("alerts");
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  // The only state this page owns is the user's own answers, keyed by alert.
  // The feed itself is derived from `pushedAlerts` during render rather than
  // copied into a second list by an effect — one source of truth, and no
  // cascading re-render when an alert lands.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  // Alerts restored from the server on load, plus the answers this household
  // already gave them. Before this, a reload emptied the feed completely —
  // every alert lived only in the socket hook's memory.
  const [restored, setRestored] = useState<DSMAlert[]>([]);
  const [restoredDecisions, setRestoredDecisions] = useState<Record<string, Decision>>({});

  // The server's own tally of what this household saved, with the speed and
  // streak bonuses already applied. The page cannot compute these: a bonus
  // depends on the gateway's delivery stamp and on answers given in other
  // sessions, neither of which is in this tab's memory.
  const [savings, setSavings] = useState<SavingsSummary | null>(null);
  const [savingsNonce, setSavingsNonce] = useState(0);
  // An answer from another device changes this household's totals, so the
  // server's figures have to be pulled again — the same reasoning as
  // `savingsNonce` after answering here. A count is enough: the echo only ever
  // adds entries, so the size moving means a new answer landed.
  const remoteAnswerCount = Object.keys(remoteDecisions).length;
  const [model, setModel] = useState<IncentiveModel | null>(null);

  // The operator reset the simulation: the hook has already emptied
  // `pushedAlerts`, so these answers refer to alerts that no longer exist.
  // Adjusting during render is React's documented pattern for this; an effect
  // would be a second pass and would trip the React Compiler's
  // set-state-in-effect rule.
  const [nonceSeen, setNonceSeen] = useState(resetNonce);
  if (resetNonce !== nonceSeen) {
    setNonceSeen(resetNonce);
    setDecisions({});
    // Restored history has to go too. The backend soft-clears its rows on
    // reset, so a refetch would return nothing anyway — but leaving these in
    // place would keep the old feed on screen until the next reload, which is
    // exactly the stale-dashboard problem system_reset exists to prevent.
    setRestored([]);
    setRestoredDecisions({});
    // Savings are per-alert state and die with the alerts. Cleared here rather
    // than refetched so the tab never shows a total for a run that no longer
    // exists — the rule in docs/ARCHITECTURE.md for anything hung off an alert.
    setSavings(null);
  }

  // Rehydrate on mount. The backend only returns alerts the ESP32 actually
  // forwarded, so this cannot surface anything the gateway did not approve —
  // see the header of src/server/history.ts.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;

    apiGetMyAlertHistory()
      .then((rows) => {
        if (cancelled) return;
        const answers: Record<string, Decision> = {};
        for (const row of rows) {
          if (row.my_response !== null && row.my_response !== undefined) {
            answers[row.alert_id + row.tick] = {
              action: row.my_response ? "accepted" : "declined",
              // triggered_at last because it is the only one guaranteed set —
              // pushed_at is null on an alert nobody pushed, though a row with
              // a my_response will always have been delivered.
              actionAt: row.delivered_at ?? row.pushed_at ?? row.triggered_at,
            };
          }
        }
        setRestored(rows.map(fromPersisted));
        setRestoredDecisions(answers);
      })
      .catch(() => {
        // History is a convenience; a live socket is the actual product. Fail
        // quiet rather than blocking the feed on it.
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Savings, refetched whenever this household answers something. Separate from
  // the history fetch above because it is the *server's* arithmetic — the speed
  // and streak bonuses depend on the gateway's delivery stamp and on answers
  // given in other sessions, so the page cannot derive them from its own feed.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    apiGetMySavings()
      .then((s) => {
        if (!cancelled) setSavings(s);
      })
      .catch(() => {
        // A missing total is not a reason to hide the alerts. Falls back to
        // the locally-derivable estimate below.
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, savingsNonce, resetNonce, remoteAnswerCount]);

  // The model, once. Static for the life of the backend, and only needed to
  // quote the speed bonus a household could still earn on a pending alert.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    apiGetIncentiveModel()
      .then((m) => {
        if (!cancelled) setModel(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Live arrivals first, then anything from history not already present. Keyed
  // on id + tick, the same composite key used everywhere else — an alert that
  // arrived this session is also in the database, and must not appear twice.
  const liveKeys = new Set(pushedAlerts.map((a) => a.id + a.tick));
  const feed: DSMAlert[] = [
    ...pushedAlerts,
    ...restored.filter((a) => !liveKeys.has(a.id + a.tick)),
  ];

  const alertLog: AlertLogEntry[] = feed.map((alert) => {
    // Three sources, most immediate first. A decision made in this session
    // wins because it is optimistic and lands before the round trip has
    // persisted it; a `remoteDecisions` echo is this household answering on
    // another device *now*, so it outranks the load-time snapshot; the
    // restored answer is the floor.
    //
    // `remoteDecisions` is keyed by alert id alone — that is all the echo
    // carries — which is safe because ids are unique per trigger.
    const key = alert.id + alert.tick;
    const remote = remoteDecisions[alert.id];
    const decision =
      decisions[key] ??
      (remote
        ? {
            action: remote.accepted ? ("accepted" as const) : ("declined" as const),
            actionAt: remote.respondedAt,
          }
        : undefined) ??
      restoredDecisions[key];
    return {
      alert,
      action: decision?.action ?? "pending",
      actionAt: decision?.actionAt,
    };
  });


  // Composite id of the most recent alert already announced. notify()'s
  // identity changes when permission does, which re-runs the effect below —
  // this is what stops that re-run from replaying the last alert.
  const lastAnnouncedRef = useRef<string | null>(null);
  const { notify } = notifications;

  // Announce arrivals. Alerts reach this page only as `pushed_alert`, which
  // means they have already completed the full
  // admin -> backend -> ESP32 -> backend -> consumer round trip. Raising an OS
  // notification here adds no delivery channel; it renders one the hardware
  // broker already approved. Nothing in this effect sets React state.
  useEffect(() => {
    const newest = pushedAlerts[0];
    if (!newest) return;

    const key = newest.id + newest.tick;
    if (key === lastAnnouncedRef.current) return;
    lastAnnouncedRef.current = key;

    playAlertSound(660, 200);
    notify(newest);
  }, [pushedAlerts, notify]);

  const settle = useCallback((alert: DSMAlert, action: "accepted" | "declined") => {
    setDecisions((prev) => ({
      ...prev,
      [alert.id + alert.tick]: { action, actionAt: new Date().toISOString() },
    }));
    apiRespondToAlert(alert.id, action === "accepted").catch(console.error);
    // Pull the totals back once the answer has been through the gateway. The
    // credit for this alert depends on how fast it was answered and on the
    // streak it continued, so only the server can say what it was worth.
    setSavingsNonce((n) => n + 1);
  }, []);

  const verdict = getVerdict(gridState);
  const accepted = alertLog.filter((e) => e.action === "accepted");
  const participatedCount = accepted.length;
  const declinedCount = alertLog.filter((e) => e.action === "declined").length;
  const pendingCount = alertLog.filter((e) => e.action === "pending").length;

  // The server's figures where available, this tab's own estimate where not.
  // The fallback is deliberately the *floor* — rate × shed, with no bonuses —
  // so an answer that has not round-tripped yet under-promises rather than
  // showing a number that drops when the real one lands.
  const creditTotal =
    savings?.total_credit_idr ??
    accepted.reduce((sum, e) => sum + estimatedCredit(e.alert), 0);
  const kwhTotal =
    savings?.total_kwh ?? accepted.reduce((sum, e) => sum + shedKwh(e.alert), 0);
  const speedBonus = topSpeedBonus(model);
  // What fraction of what was asked for this household actually shifted, and
  // the streak they are on. Both server-derived — see lib/domain.ts.
  const captured = capturedFraction(savings);
  const streak = savings?.current_streak ?? 0;
  const streakMultiplier = savings?.streak_multiplier ?? 1;

  // Auth guard
  useEffect(() => {
    if (!isLoading && (!isAuthenticated || role !== "consumer")) {
      router.push("/login");
    }
  }, [isLoading, isAuthenticated, role, router]);

  if (isLoading || !isAuthenticated || role !== "consumer") {
    return null;
  }

  const p = gridState?.parameters;
  const m = gridState?.measurements;

  // The household's own draw, charged at the live rate. kW x Rp/kWh = Rp/hour.
  // `measurements` is this house's meter; `parameters` are neighbourhood scale.
  // Mixing the two in one grid of readings was the old Grid tab's core problem.
  const costPerHour = p && m ? m.global_active_power * p.retail_price_idr : null;

  return (
    <div className="ds-app">
      {/* ── App bar ──
          Two badges, because there are two independent paths here and they
          fail separately: readings come straight from the backend, alerts only
          arrive via the ESP32 gateway. One "connected" light would hide that. */}
      <header className="ds-app__top">
        <div className="ds-app__brand">
          DSM
          <span>Energy Assistant</span>
        </div>
        <div className="ds-header__aside">
          <span
            className={`ds-badge ${connected ? "ds-badge--live" : "ds-badge--offline"}`}
            title="Live grid readings, streamed from the backend"
          >
            <span className="ds-dot" />
            Readings
          </span>
          <span
            className={`ds-badge ${esp32Connected ? "ds-badge--live" : "ds-badge--offline"}`}
            title="Alerts reach this phone only through the ESP32 gateway"
          >
            <span className="ds-dot" />
            Alerts
          </span>
          <button className="ds-btn ds-btn--sm" onClick={logout}>
            Exit
          </button>
        </div>
      </header>

      <main className="ds-app__body">
        {/* ── Alerts ── */}
        {tab === "alerts" && (
          <>
            {/* The state the fail-closed design actually produces, said out
                loud. An empty feed otherwise looks identical to a calm grid. */}
            {!esp32Connected && (
              <div className="ds-notice ds-notice--warn">
                <div className="ds-notice__body">
                  <strong>Alerts can&rsquo;t reach you right now.</strong> The gateway that
                  carries them is offline. Your grid readings below are still live — they come
                  by a different route.
                </div>
              </div>
            )}

            <NotificationNotice
              support={notifications.support}
              permission={notifications.permission}
              onRequest={notifications.request}
              dismissed={noticeDismissed}
              onDismiss={() => setNoticeDismissed(true)}
            />

            <div className="ds-title">
              Your alerts
              <span className="ds-title__meta">
                {alertLog.length} total · {pendingCount} waiting on you
              </span>
            </div>

            {alertLog.length === 0 ? (
              <div className="ds-card ds-empty">
                <strong>Nothing to decide yet</strong>
                Alerts pushed by your grid operator will appear here.
              </div>
            ) : (
              alertLog.map((entry) => (
                // Keyed by the alert's own identity, NOT the array index. New
                // alerts are prepended, so an index key shifts every row and
                // remounts the whole list — replaying the entry animation on
                // every arrival and losing any in-progress interaction.
                <AlertCard
                  key={entry.alert.id + entry.alert.tick}
                  entry={entry}
                  speedBonus={speedBonus}
                  onSettle={settle}
                />
              ))
            )}
          </>
        )}

        {/* ── Now ──
            Household-first: the decision, then this house's own usage and what
            it is costing. Grid-operator readings are real but secondary, so
            they live behind a disclosure rather than competing for the top. */}
        {tab === "now" && (
          <>
            <div className={`ds-verdict ds-verdict--${verdict.level}`}>
              <div className="ds-verdict__label">Right now</div>
              <div className="ds-verdict__headline">{verdict.headline}</div>
              <div className="ds-verdict__detail">{verdict.detail}</div>
              {/* Why. The verdict used to state an instruction with no reason
                  attached, which is the difference between an assistant and a
                  scold. Named from the same triggered flags the verdict itself
                  switches on, in the engine's own priority order. */}
              {verdict.cause && (
                <div className="ds-verdict__cause">Because {verdict.cause}.</div>
              )}
            </div>

            {/* Draw, rate and what the two multiply out to, in one panel.
                These were two separate cards with identical structure — a
                title and one number each — which made the household read two
                boxes to answer one question. The cost line is the only figure
                here they can act on, so it is stated rather than left to be
                worked out from the other two. */}
            {/* Titled "Your usage", not "Right now" — the verdict block
                directly above already carries that label, and two identical
                headings stacked read as one section broken in half. */}
            <div className="ds-card ds-card--pad-sm ds-stack">
              <div className="ds-title">Your usage</div>
              <div className="ds-grid ds-grid--pair">
                <Metric
                  label="You're using"
                  value={m ? m.global_active_power.toFixed(2) : "—"}
                  sub="kW"
                />
                <Metric
                  label="Rate"
                  value={p ? `Rp ${Math.round(p.retail_price_idr).toLocaleString()}` : "—"}
                  sub="per kWh"
                />
              </div>
              {costPerHour !== null && (
                <p className="ds-muted">
                  That&apos;s about{" "}
                  <strong>Rp {Math.round(costPerHour).toLocaleString()}</strong> per hour if
                  you keep going at this rate.
                </p>
              )}
              {p?.price_spike_triggered && (
                <Notice tone="pending" title="Price spike active.">
                  Deferring heavy usage now saves the most.
                </Notice>
              )}
            </div>

            {p && (
              <details className="ds-details">
                <summary>Grid detail</summary>
                <div className="ds-details__body">
                  {/* --pair, not --2/--4: this sits in the fixed-width app
                      column, so it must not re-flow with the browser window. */}
                  <div className="ds-grid ds-grid--pair">
                    <Metric
                      label="Spare capacity"
                      value={`${p.reserve_margin_pct.toFixed(1)}%`}
                      sub="how much headroom the grid has left"
                    />
                    <Metric
                      label="Frequency"
                      value={`${p.frequency_hz.toFixed(2)} Hz`}
                      sub="50 Hz means supply matches demand"
                    />
                    <Metric
                      label="Clean energy"
                      value={`${(p.renewable_fraction * 100).toFixed(0)}%`}
                      sub={`solar ${p.solar_output_kw.toFixed(0)} kW · wind ${p.wind_output_kw.toFixed(0)} kW`}
                    />
                    <Metric
                      label="Your voltage"
                      value={`${m?.voltage?.toFixed(1) ?? "—"} V`}
                      sub="nominal 220 V"
                    />
                  </div>
                </div>
              </details>
            )}
          </>
        )}

        {/* ── Savings ── */}
        {tab === "savings" && (
          <>
            {/* Energy first, money second. The credit is what makes a household
                act; the kWh is what the programme actually exists to move, and
                only one of the two was on screen before. */}
            <div className="ds-card ds-stack">
              <div className="ds-title">Energy you helped shift</div>
              <div className="ds-metric ds-metric--hero">
                <span className="ds-metric__value">{kwh(kwhTotal)} kWh</span>
                <span className="ds-metric__sub">
                  worth about <strong>Rp {idr(creditTotal)}</strong> in bill credit
                </span>
              </div>
              {/* How much of what was actually asked for. This replaced a
                  progress bar against a hardcoded Rp 50,000 "goal" — a number
                  with nothing behind it, which never reset, so crossing it once
                  pinned the bar full forever.

                  Measured in kWh rather than rupiah because credit carries the
                  speed and streak multipliers and could exceed the denominator.
                  Absent, not zero, before anything has been asked: an empty bar
                  labelled 0% reads as a failure rather than as a fresh start. */}
              {captured !== null && savings && (
                <div>
                  <div className="ds-progress">
                    <div
                      className="ds-progress__fill"
                      style={{ width: `${captured * 100}%` }}
                    />
                  </div>
                  <div className="ds-progress-legend">
                    <span>
                      {kwh(savings.total_kwh)} of {kwh(savings.offered_kwh)} kWh asked
                    </span>
                    <span>
                      <strong>{Math.round(captured * 100)}%</strong>
                    </span>
                  </div>
                </div>
              )}

              {/* The household's record, as a grouped list rather than three
                  boxed figures. This was a separate "Your record" card at the
                  bottom of the tab restating four numbers that were all already
                  on screen — accepted and declined in the line above, pending on
                  the tab bar badge.

                  The streak is here rather than behind the "How this is worked
                  out" disclosure: it is a real, server-computed multiplier the
                  household is currently earning, and it was the one figure on
                  the tab that could change their behaviour, hidden. */}
              <div className="ds-group">
                <div className="ds-group__row">
                  <span className="ds-group__label">Alerts you answered</span>
                  <span className="ds-group__value">
                    {participatedCount} accepted · {declinedCount} declined
                  </span>
                </div>
                {pendingCount > 0 && (
                  <div className="ds-group__row">
                    <span className="ds-group__label">Still waiting on you</span>
                    <span className="ds-group__value">{pendingCount}</span>
                  </div>
                )}
                {streak > 1 && (
                  <div className="ds-group__row">
                    <span className="ds-group__label">Accepted in a row</span>
                    <span className="ds-group__value">
                      {streak} · earning {multiplier(streakMultiplier)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Where it came from, by grid condition. The per-alert ledger this
                replaced could not survive a reload — it was built from this
                tab's own feed — and it said nothing about which conditions the
                household was actually helping with. */}
            <div className="ds-card ds-card--pad-sm">
              <div className="ds-title">Where it came from</div>
              {!savings || savings.by_parameter.length === 0 ? (
                <div className="ds-empty">
                  <strong>Nothing yet</strong>
                  Accept an alert and the energy you shift shows up here.
                </div>
              ) : (
                savings.by_parameter.map((b) => (
                  <div key={b.key} className="ds-ledger">
                    <span className="ds-ledger__what">
                      {PARAMETER_LABELS[b.key] ?? b.key}
                      <span className="ds-ledger__when">
                        {b.responses} {b.responses === 1 ? "alert" : "alerts"} ·{" "}
                        {kwh(b.kwh)} kWh
                      </span>
                    </span>
                    <span className="ds-ledger__amount">Rp {idr(b.credit_idr)}</span>
                  </div>
                ))
              )}
            </div>

            {/* What the household is currently earning above the base rate,
                folded in beside the disclaimer that explains those same
                multipliers. It was its own card quoting theoretical maxima —
                the one figure on the tab a household could not act on. */}
            <details className="ds-details">
              <summary>How this is worked out</summary>
              <div className="ds-details__body ds-stack">
                <p className="ds-muted">
                  This is an <strong>estimate</strong>, not a billed figure. Each alert
                  asks for a different amount depending on the grid condition and how
                  urgent it is, credited at that alert&rsquo;s own rate (Rp
                  300–2,000/kWh). Nothing here is read from your meter.
                </p>
                {savings && savings.accepted_count > 0 && (
                  <div>
                    <div className="ds-row">
                      <span>Answering fast</span>
                      <span className="ds-row__mono">
                        {speedBonus ? `up to ${multiplier(speedBonus.multiplier)}` : "—"}
                      </span>
                    </div>
                    <div className="ds-row ds-row--last">
                      <span>Accepting in a row</span>
                      <span className="ds-row__mono">
                        {/* The ceiling, and where they actually are on the way
                            to it — a theoretical maximum on its own is the one
                            number here nobody can act on. */}
                        {streak > 1 && `${multiplier(streakMultiplier)} now · `}
                        up to{" "}
                        {multiplier(
                          1 + (model?.streak_step ?? 0) * (model?.streak_max_steps ?? 0)
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </details>
          </>
        )}

        {gridState && (
          <div className="ds-app__foot">
            {gridState.timestamp} · tick {gridState.tick.toLocaleString()}
          </div>
        )}
      </main>

      {/* ── Bottom tab bar ── */}
      <nav className="ds-tabbar" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="ds-tab"
            onClick={() => setTab(t.id)}
          >
            <span className="ds-tab__mark">
              <Icon name={t.icon} size={22} />
            </span>
            {t.label}
            {t.id === "alerts" && pendingCount > 0 && (
              <span className="ds-tab__badge" aria-label={`${pendingCount} waiting`}>
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ── Pieces ─────────────────────────────────────────────────────────── */

/**
 * One alert, stating the commitment before asking for a decision — the old
 * "Participate / Opt Out" buttons never said what participating meant.
 */
function AlertCard({
  entry,
  speedBonus,
  onSettle,
}: {
  entry: AlertLogEntry;
  /** Best speed tier still on offer, from GET /api/incentives. */
  speedBonus: { multiplier: number; label: string } | null;
  onSettle: (alert: DSMAlert, action: "accepted" | "declined") => void;
}) {
  const alert = entry.alert;
  const isPending = entry.action === "pending";
  const ask = PARAMETER_ASKS[alert.parameter] ?? DEFAULT_PARAMETER_ASK;
  // The floor: rate × shed, no multipliers. Answering fast or continuing a
  // streak pays more, and quoting the optimistic figure up front would mean
  // showing a number the household then misses by taking a minute to think.
  const credit = estimatedCredit(alert);
  const shed = shedKwh(alert);
  const throttle = throttleLine(alert);

  return (
    <div className={`ds-alert ds-alert--${alert.severity}`}>
      <div className="ds-alert__strip">
        <span className="ds-alert__sev">{alert.severity}</span>
        <span className="ds-alert__time">{alert.timestamp}</span>
      </div>
      <div className="ds-alert__body">
        <div className="ds-alert__head">
          <div className="ds-flex-1">
            <div className="ds-alert__title">{alert.title}</div>
            <div className="ds-alert__msg">{alert.message}</div>
          </div>
          {!isPending && (
            <span
              className={`ds-badge ${entry.action === "accepted" ? "ds-badge--accepted" : "ds-badge--declined"}`}
            >
              {entry.action === "accepted" ? "Accepted" : "Declined"}
            </span>
          )}
        </div>

        {isPending ? (
          <>
            <div className="ds-sheet">
              <div className="ds-sheet__row">
                <span className="ds-sheet__label">You do</span>
                <span className="ds-sheet__value">{ask}</span>
              </div>
              {/* The same ask as a setpoint, which is what the upcoming
                  throttle will hold. Guarded: alerts from before the throttle
                  model carry no window, and inventing one would state a
                  commitment nobody asked for. */}
              {throttle && (
                <div className="ds-sheet__row">
                  <span className="ds-sheet__label">Roughly</span>
                  <span className="ds-sheet__value">{throttle}</span>
                </div>
              )}
              <div className="ds-sheet__row">
                <span className="ds-sheet__label">If accept</span>
                <span className="ds-sheet__value">
                  {credit > 0
                    ? `Earn at least Rp ${idr(credit)} in bill credit (est. for ${kwh(shed)} kWh shifted).`
                    : "You help stabilise the grid. No bill credit applies to this alert."}
                </span>
              </div>
              {/* The reason to answer *now* rather than later, stated before the
                  buttons. The bonus is real and already measured from the
                  gateway's delivery — it was simply never shown to the person
                  who could earn it. */}
              {credit > 0 && speedBonus && (
                <div className="ds-sheet__row">
                  <span className="ds-sheet__label">If quick</span>
                  <span className="ds-sheet__value">
                    Answer {speedBonus.label} and it&rsquo;s worth{" "}
                    {multiplier(speedBonus.multiplier)} — about Rp{" "}
                    {idr(credit * speedBonus.multiplier)}.
                  </span>
                </div>
              )}
              <div className="ds-sheet__row">
                <span className="ds-sheet__label">If decline</span>
                <span className="ds-sheet__value">
                  Nothing changes — keep using power as normal at the standard rate.
                </span>
              </div>
              {alert.incentive && <div className="ds-sheet__note">{alert.incentive}</div>}
            </div>
            <div className="ds-alert__actions">
              <button
                className="ds-btn ds-btn--accept ds-flex-1"
                onClick={() => onSettle(alert, "accepted")}
              >
                Accept &mdash; Reduce Usage
              </button>
              <button className="ds-btn" onClick={() => onSettle(alert, "declined")}>
                Decline
              </button>
            </div>
          </>
        ) : (
          <div
            className={`ds-outcome ${entry.action === "declined" ? "ds-outcome--declined" : ""}`}
          >
            {entry.action === "accepted" ? (
              <>
                <strong>You accepted.</strong> You agreed to{" "}
                {ask.charAt(0).toLowerCase() + ask.slice(1)}
                {credit > 0 ? ` About ${kwh(shed)} kWh shifted, from Rp ${idr(credit)}.` : ""}
              </>
            ) : (
              <>
                <strong>You declined.</strong> No action was taken and no credit was earned
                — you continue at the standard rate.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Explains why notifications are or aren't available, rather than silently
 * doing nothing. The insecure-context case is the common one: a phone on the
 * LAN reaches this app over plain HTTP, where browsers withhold the
 * Notification API entirely.
 */
function NotificationNotice({
  support,
  permission,
  onRequest,
  dismissed,
  onDismiss,
}: {
  support: ReturnType<typeof useAlertNotifications>["support"];
  permission: NotificationPermission;
  onRequest: () => Promise<void>;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  if (dismissed) return null;

  if (support === "insecure") {
    return (
      <div className="ds-notice">
        <div className="ds-notice__body">
          <strong>Notifications need HTTPS.</strong> This page is served over plain HTTP,
          so your browser blocks them. Alerts still arrive here live with a sound while the
          app is open.
        </div>
        <button className="ds-notice__dismiss" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  if (support === "unsupported") {
    return (
      <div className="ds-notice">
        <div className="ds-notice__body">
          This browser has no notification support. Alerts still arrive here live with a
          sound while the app is open.
        </div>
        <button className="ds-notice__dismiss" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="ds-notice">
        <div className="ds-notice__body">
          Notifications are blocked for this site. Re-enable them in your browser&rsquo;s
          site settings if you want alerts while the app is in the background.
        </div>
        <button className="ds-notice__dismiss" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  if (permission === "default") {
    return (
      <Notice
        tone="pending"
        title="Get alerted when the grid needs you."
        onDismiss={onDismiss}
      >
        Notifications appear while this app is open or in the background.
        <span className="ds-actions">
          <button className="ds-btn ds-btn--sm" onClick={onRequest}>
            Enable notifications
          </button>
        </span>
      </Notice>
    );
  }

  // Granted. Nudge toward installing, unless already running as an installed
  // app — that case is hidden by CSS, no JS or hydration risk involved.
  return (
    <div className="ds-notice ds-install-hint">
      <div className="ds-notice__body">
        <strong>Notifications on.</strong> Install this app from your browser&rsquo;s Share
        menu (&ldquo;Add to Home Screen&rdquo;) to get alerts without keeping a tab open.
      </div>
      <button className="ds-notice__dismiss" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
