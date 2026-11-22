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
// The credit model lives on the backend now.
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
import { DELIVERY_GRACE_MS } from "@/lib/constants";
import { Metric } from "@/components/Metric";
import { Notice } from "@/components/Notice";
import { Icon, type IconName } from "@/components/Icon";
import { BrinEmblem } from "@/components/Brand";

/** One answer. */
type Decision = {
  action: "accepted" | "declined";
  actionAt: string;
  delivery?: "sending" | "failed";
};

/** A persisted alert, back in the shape the UI already renders. */
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
    // Must be copied, or a *restored* alert loses what it asks for and the pre-answer preview reads
    // "no bill credit applies to this alert" for one worth thousands of rupiah.
    expected_shed_kwh: row.expected_shed_kwh,
    duration_minutes: row.duration_minutes,
    target_reduction_w: row.target_reduction_w,
    auto_push_status: row.auto_pushed ? "sent" : null,
  };
}

/** Grid conditions in household language, for the savings breakdown. */
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
    // Answers this household gave on another device, echoed back through the gateway.
    remoteDecisions,
  } = useGridWebSocket({
    clientType: "consumer",
    maxAlerts: 100,
  });
  const notifications = useAlertNotifications();

  // The socket was rejected and could not be refreshed — this household was suspended or deleted
  // while the app was open.
  useEffect(() => {
    if (authFailed) router.replace("/login");
  }, [authFailed, router]);

  const [tab, setTab] = useState<Tab>("alerts");
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  // The only state this page owns is the user's own answers, keyed by alert.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  // Alerts restored from the server on load, plus the answers this household already gave them.
  const [restored, setRestored] = useState<DSMAlert[]>([]);
  const [restoredDecisions, setRestoredDecisions] = useState<Record<string, Decision>>({});

  // The server's own tally of what this household saved, with the speed and streak bonuses already
  // applied.
  const [savings, setSavings] = useState<SavingsSummary | null>(null);
  const [savingsNonce, setSavingsNonce] = useState(0);
  // An answer from another device changes this household's totals, so the server's figures have to
  // be pulled again — the same reasoning as `savingsNonce` after answering here.
  const [model, setModel] = useState<IncentiveModel | null>(null);

  const [nonceSeen, setNonceSeen] = useState(resetNonce);
  if (resetNonce !== nonceSeen) {
    setNonceSeen(resetNonce);
    setDecisions({});
    // Restored history has to go too.
    setRestored([]);
    setRestoredDecisions({});
    // Savings are per-alert state and die with the alerts.
    setSavings(null);
  }

  // Rehydrate on mount.
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
              // triggered_at last because it is the only one guaranteed set — pushed_at is null on
              // an alert nobody pushed, though a row with a my_response will always have been
              // delivered.
              actionAt: row.delivered_at ?? row.pushed_at ?? row.triggered_at,
            };
          }
        }
        setRestored(rows.map(fromPersisted));
        setRestoredDecisions(answers);
      })
      .catch(() => {
        // History is a convenience; a live socket is the actual product.
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Savings, refetched whenever this household answers something.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    apiGetMySavings()
      .then((s) => {
        if (!cancelled) setSavings(s);
      })
      .catch(() => {
        // A missing total is not a reason to hide the alerts.
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, savingsNonce, resetNonce, remoteDecisions]);

  // The model, once.
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

  // Live arrivals first, then anything from history not already present.
  const liveKeys = new Set(pushedAlerts.map((a) => a.id + a.tick));
  const feed: DSMAlert[] = [
    ...pushedAlerts,
    ...restored.filter((a) => !liveKeys.has(a.id + a.tick)),
  ];

  const alertLog: AlertLogEntry[] = feed.map((alert) => {
    // Three sources, most immediate first.
    const key = alert.id + alert.tick;
    const remote = remoteDecisions[alert.id];
    const remoteDecision: Decision | undefined = remote
      ? { action: remote.accepted ? "accepted" : "declined", actionAt: remote.respondedAt }
      : undefined;
    const local = decisions[key];
    // A local answer still in flight is confirmed by an echo of the same answer; until then it is
    // only a tap.
    const confirmed =
      local?.delivery === "sending" && remoteDecision?.action === local.action ? remoteDecision : undefined;
    const decision = confirmed ?? local ?? remoteDecision ?? restoredDecisions[key];

    if (decision?.delivery === "failed") {
      // The answer reached nobody.
      return { alert, action: "pending", delivery: "failed", failedAction: decision.action };
    }
    return {
      alert,
      action: decision?.action ?? "pending",
      actionAt: decision?.actionAt,
      delivery: decision?.delivery,
    };
  });

  // Composite id of the most recent alert already announced.
  const lastAnnouncedRef = useRef<string | null>(null);
  const { notify } = notifications;

  // Announce arrivals.
  useEffect(() => {
    const newest = pushedAlerts[0];
    if (!newest) return;

    const key = newest.id + newest.tick;
    if (key === lastAnnouncedRef.current) return;
    lastAnnouncedRef.current = key;

    playAlertSound(660, 200);
    notify(newest);
  }, [pushedAlerts, notify]);

  // Read by the delivery timeout, which outlives the render it was set in.
  const remoteRef = useRef(remoteDecisions);
  useEffect(() => {
    remoteRef.current = remoteDecisions;
  }, [remoteDecisions]);

  /** Answer an alert. */
  const settle = useCallback(async (alert: DSMAlert, action: "accepted" | "declined") => {
    const key = alert.id + alert.tick;
    const mark = (delivery: Decision["delivery"]) =>
      setDecisions((prev) =>
        // Only touch the answer this call made: a second tap supersedes it.
        prev[key]?.action === action && prev[key]?.delivery === "sending"
          ? { ...prev, [key]: { ...prev[key], delivery } }
          : prev,
      );

    setDecisions((prev) => ({
      ...prev,
      [key]: { action, actionAt: new Date().toISOString(), delivery: "sending" },
    }));

    let relayed = false;
    try {
      relayed = (await apiRespondToAlert(alert.id, action === "accepted")).esp32_connected;
    } catch (err) {
      console.error("Respond failed:", err);
    }
    if (!relayed) {
      mark("failed");
      return;
    }
    // Handed to the gateway.
    setTimeout(() => {
      const echoed = remoteRef.current[alert.id];
      if (echoed && (echoed.accepted ? "accepted" : "declined") === action) return;
      mark("failed");
    }, DELIVERY_GRACE_MS);
    setSavingsNonce((n) => n + 1);
  }, []);

  const verdict = getVerdict(gridState);
  const accepted = alertLog.filter((e) => e.action === "accepted");
  const participatedCount = accepted.length;
  const declinedCount = alertLog.filter((e) => e.action === "declined").length;
  const pendingCount = alertLog.filter((e) => e.action === "pending").length;

  // The server's figures where available, this tab's own estimate where not.
  const creditTotal =
    savings?.total_credit_idr ??
    accepted.reduce((sum, e) => sum + estimatedCredit(e.alert), 0);
  const kwhTotal =
    savings?.total_kwh ?? accepted.reduce((sum, e) => sum + shedKwh(e.alert), 0);
  const speedBonus = topSpeedBonus(model);
  // What fraction of what was asked for this household actually shifted, and the streak they are
  // on.
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

  // The household's own draw, charged at the live rate.
  const costPerHour = p && m ? m.global_active_power * p.retail_price_idr : null;

  return (
    <div className="ds-app">
      {/*
          ── App bar ── Two badges, because there are two independent paths here and they fail
          separately: readings come straight from the backend, alerts only arrive via the ESP32
          gateway.
      */}
      <header className="ds-app__top">
        <div className="ds-app__brandrow">
          <BrinEmblem size={30} />
          <div className="ds-app__brand">
            DSM Grid
            <span>Energy assistant</span>
          </div>
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
            {/* The state the fail-closed design actually produces, said out loud. */}
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
                // Keyed by the alert's own identity, NOT the array index.
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

        {/*
            ── Now ── Household-first: the decision, then this house's own usage and what it is
            costing.
        */}
        {tab === "now" && (
          <>
            <div className={`ds-verdict ds-verdict--${verdict.level}`}>
              <div className="ds-verdict__headline">{verdict.headline}</div>
              <div className="ds-verdict__detail">{verdict.detail}</div>
              {/* Why. */}
              {verdict.cause && (
                <div className="ds-verdict__cause">Because {verdict.cause}.</div>
              )}
            </div>

            {/* Draw, rate and what the two multiply out to, in one panel. */}
            {/*
                Titled "Your usage", not "Right now" — the verdict block directly above already
                carries that label, and two identical headings stacked read as one section broken in
                half.
            */}
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
                  {/*
                      --pair, not --2/--4: this sits in the fixed-width app column, so it must not
                      re-flow with the browser window.
                  */}
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
            {/* Energy first, money second. */}
            <div className="ds-card ds-stack">
              <div className="ds-title">Energy you helped shift</div>
              <div className="ds-metric ds-metric--hero">
                <span className="ds-metric__value">{kwh(kwhTotal)} kWh</span>
                <span className="ds-metric__sub">
                  worth about <strong>Rp {idr(creditTotal)}</strong> in bill credit
                </span>
              </div>
              {/* How much of what was actually asked for. */}
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

              {/* The household's record, as a grouped list rather than three boxed figures. */}
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

            {/* Where it came from, by grid condition. */}
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

            {/*
                What the household is currently earning above the base rate, folded in beside the
                disclaimer that explains those same multipliers.
            */}
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
                        {/*
                            The ceiling, and where they actually are on the way to it — a
                            theoretical maximum on its own is the one number here nobody can act on.
                        */}
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
 * One alert, stating the commitment before asking for a decision — the old "Participate / Opt Out"
 * buttons never said what participating meant.
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
  // The floor: rate × shed, no multipliers.
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
          {!isPending && entry.delivery === "sending" && (
            <span className="ds-badge ds-badge--sending">Sending…</span>
          )}
          {!isPending && entry.delivery !== "sending" && (
            <span
              className={`ds-badge ${entry.action === "accepted" ? "ds-badge--accepted" : "ds-badge--declined"}`}
            >
              {entry.action === "accepted" ? "Accepted" : "Declined"}
            </span>
          )}
        </div>

        {isPending ? (
          <>
            {entry.delivery === "failed" && (
              <Notice tone="error" title="Your answer didn't reach the operator">
                The gateway didn&rsquo;t pass on your{" "}
                {entry.failedAction === "declined" ? "decline" : "accept"}. Check the
                gateway light at the top, then answer again.
              </Notice>
            )}
            <div className="ds-sheet">
              <div className="ds-sheet__row">
                <span className="ds-sheet__label">You do</span>
                <span className="ds-sheet__value">{ask}</span>
              </div>
              {/* The same ask as a setpoint, which is what the upcoming throttle will hold. */}
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
              {/* The reason to answer *now* rather than later, stated before the buttons. */}
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

/** Explains why notifications are or aren't available, rather than silently doing nothing. */
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

  // Granted.
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
