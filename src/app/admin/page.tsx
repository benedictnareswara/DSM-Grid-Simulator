"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  playAlertSound,
  apiStart,
  apiPause,
  apiResume,
  apiReset,
  apiSetSpeed,
  apiSetAutopush,
  apiGetAlertHistory,
  apiGetSavings,
  apiGetIncentiveModel,
} from "@/hooks/useGridWebSocket";
import { AccountsPanel } from "./AccountsPanel";
import { PageHeader } from "@/components/PageHeader";
import { getOperatorVerdict, trippedCount } from "./verdict";
import { useAdminSocket } from "./GridSocketProvider";
import { AlertRow, isFailed, keyOf } from "./AlertRow";
import { useAlertOutcomes } from "./useAlertOutcomes";
import { Metric } from "@/components/Metric";
import { Icon } from "@/components/Icon";
import {
  PARAMETER_CONFIGS,
  type DSMAlert,
  type DSMResponse,
  type SimulationPhase,
  type PersistedAlert,
  type SavingsSummary,
  type IncentiveModel,
} from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";

/*
 * Deferred chunks.
 *
 * Everything below is loaded on demand rather than in the page's own bundle.
 * `GridCharts` is the expensive one: it pulls Recharts, which minifies to
 * ~400 kB — about 85% of everything this route ships that the framework does
 * not, and roughly a third of the whole page weight. It renders below the
 * alert feed and is not on the path to first paint, so holding the operator's
 * first render hostage to it was pure cost.
 *
 * The three panels are modals behind operator toggles (`tuning`, `testing`,
 * `confirmReset`). None of them can be on screen at load, so none of them
 * belong in the initial payload.
 *
 * `ssr: false` throughout: these are client-only surfaces (Recharts measures
 * the DOM, the panels are dialogs), so prerendering them buys nothing. The
 * chart carries a skeleton at its final height so the deferred load does not
 * shift the layout underneath it — the modals need no placeholder, since
 * nothing is visible until the operator opens one anyway.
 */
const GridCharts = dynamic(() => import("./GridCharts").then((m) => m.GridCharts), {
  ssr: false,
  loading: () => <div className="ds-card ds-chart ds-skeleton ds-skeleton--card" />,
});

const ThresholdPanel = dynamic(
  () => import("./ThresholdPanel").then((m) => m.ThresholdPanel),
  { ssr: false }
);

const TestAlertPanel = dynamic(
  () => import("./TestAlertPanel").then((m) => m.TestAlertPanel),
  { ssr: false }
);

const ResetConfirm = dynamic(() => import("./ResetConfirm").then((m) => m.ResetConfirm), {
  ssr: false,
});

/**
 * Human-readable run state. `phase` is derived on the backend.
 *
 * `idle` reads "Ready", not "Stopped" — with the Stop button gone it is only
 * reachable from a fresh boot or a Reset, both of which leave the simulator at
 * tick 0 waiting to be started.
 */
const PHASE_LABEL: Record<SimulationPhase, string> = {
  idle: "Ready",
  running: "Running",
  paused: "Paused",
  finished: "Finished",
};

export default function AdminDashboard() {
  const { isAuthenticated, role, isLoading } = useAuth();
  const router = useRouter();

  // ALL hooks called unconditionally
  const {
    gridState,
    alerts,
    history,
    responses,
    esp32Connected,
    status,
    autopushEnabled,
    consumerCount,
    authFailed,
    resetNonce,
    accountsNonce,
    responsesNonce,
    // The live trip points, over the socket rather than a mount-only fetch —
    // an operator retuning in one tab now relabels the gauges in every other.
    thresholds,
    // Shared with the sidebar rather than opened here. Calling
    // useGridWebSocket again in this file would give the tab two admin
    // sockets — see the note in GridSocketProvider.tsx.
    historyNonce,
    bumpHistory,
  } = useAdminSocket();

  // The socket was rejected and could not be refreshed — the account was
  // suspended or deleted while this tab was open. The hook has already dropped
  // the session; this is what gets the operator off a dashboard they are no
  // longer allowed to see.
  useEffect(() => {
    if (authFailed) router.replace("/login");
  }, [authFailed, router]);

  const [speed, setSpeed] = useState(1000);
  const [serverSpeed, setServerSpeed] = useState<number | null>(null);
  const [togglingAutopush, setTogglingAutopush] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [testing, setTesting] = useState(false);

  // The server is the authority on run state. `phase` collapses running+paused
  // (plus the "finished" case neither boolean can express) into the single
  // value the controls switch on, so the UI cannot invent a state the backend
  // doesn't have. Derived rather than mirrored, which keeps tabs in step.
  const phase: SimulationPhase = status?.phase ?? "idle";

  // Adjust the slider when the *server's* speed changes (React's documented
  // "adjust state during render" pattern — an effect here would cascade).
  // Local drags aren't clobbered: they set the same value they just requested.
  if (status && status.tick_interval_ms !== serverSpeed) {
    setServerSpeed(status.tick_interval_ms);
    setSpeed(status.tick_interval_ms);
  }

  // The feed and participation log, restored from the database. This is what makes
  // the dashboard survive a logout, a reload, a token refresh or a backend
  // restart: before this, every alert and every outcome lived only in React
  // state, so closing the tab erased the operator's whole session.
  const [stored, setStored] = useState<PersistedAlert[]>([]);
  const [savings, setSavings] = useState<SavingsSummary | null>(null);
  // The served shed and window tables. The test-alert panel previews the
  // setpoint it is about to ask for; restating those tables here would be the
  // fifth copy of the mistake `/api/incentives` exists to prevent.
  const [incentives, setIncentives] = useState<IncentiveModel | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // Which half of the feed is showing. Pending is the default: the blocking
  // work is what an operator opens this page for.
  const [feedView, setFeedView] = useState<"pending" | "all">("pending");

  const { outcomeOf, pushAlert, ignoreAlert, undoIgnore, pushing, clear } =
    useAlertOutcomes({ stored, onMutated: bumpHistory });

  // A reset purges every feed system-wide, and this state describes alerts that
  // no longer exist. Same adjust-during-render pattern as the speed slider
  // above — an effect would be a second render pass and would trip the React
  // Compiler's set-state-in-effect rule.
  const [nonceSeen, setNonceSeen] = useState(resetNonce);
  if (resetNonce !== nonceSeen) {
    setNonceSeen(resetNonce);
    clear();
    // The backend soft-clears the rows too, so a refetch would return nothing;
    // dropping them here avoids showing a dead feed until the next load.
    setStored([]);
    setSavings(null);
  }

  // Hydrate from the database. Re-runs on `historyNonce`, which every operator
  // action bumps, and on `responsesNonce`, which a household answering bumps.
  //
  // That second dependency is the whole fix for a stale dashboard. Everything
  // aggregate on this page — the participation tile, the energy-saved tile, the
  // savings chart — is derived from what this effect fetches, and it used to
  // re-run only when the *operator* did something. So an operator watching a
  // push land could see an alert row's tally climb while the totals above it
  // stayed frozen at whatever they were when they last clicked Push.
  useEffect(() => {
    if (!isAuthenticated || role !== "admin") return;
    let cancelled = false;

    // No separate participation fetch: each alert row already carries its own
    // `responses`, so asking for the 200 most recent answers as well was a
    // second window onto the same rows that could disagree with the first.
    Promise.all([apiGetAlertHistory({ limit: 200 }), apiGetSavings()])
      .then(([alertRows, savingsSummary]) => {
        if (cancelled) return;
        setStored(alertRows);
        setSavings(savingsSummary);
        setHydrated(true);
      })
      .catch(() => {
        // The live socket still works without history; don't block the feed.
        if (!cancelled) setHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, role, historyNonce, resetNonce, responsesNonce]);

  // Fetched once, not on the nonces above: this is backend configuration, and
  // nothing an operator or a household does moves it.
  useEffect(() => {
    if (!isAuthenticated || role !== "admin") return;
    let cancelled = false;
    apiGetIncentiveModel()
      .then((model) => {
        if (!cancelled) setIncentives(model);
      })
      .catch(() => {
        // The panel degrades to "waiting for the incentive model…" and its
        // Send button stays disabled, which is the correct failure: without
        // the served tables there is no setpoint to preview.
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, role]);

  // Alert arrivals are prepended by the WebSocket hook. Track their composite
  // identity so the arrival sound fires once per alert, including the first.
  const latestAlertKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const latestAlert = alerts[0];
    if (!latestAlert) return;

    const key = keyOf(latestAlert);
    if (key !== latestAlertKeyRef.current) {
      latestAlertKeyRef.current = key;
      playAlertSound(880, 120);
    }
  }, [alerts]);

  // ── Merge stored and live ──
  // Live arrivals first, then anything from the database not already present,
  // keyed on `id + tick`. Same pattern as the consumer page.
  // An alert that arrived over this socket is also a row in the database, and must
  // appear once.
  const liveKeys = new Set(alerts.map(keyOf));
  const storedAsAlerts: DSMAlert[] = stored
    .filter((s) => !liveKeys.has(s.alert_id + s.tick))
    .map((s) => ({
      id: s.alert_id,
      tick: s.tick,
      timestamp: s.timestamp,
      severity: s.severity,
      parameter: s.parameter,
      title: s.title,
      message: s.message,
      incentive: s.incentive ?? undefined,
      value: s.value,
      threshold: s.threshold,
      reward_idr_per_kwh: s.reward_idr_per_kwh,
      expected_shed_kwh: s.expected_shed_kwh,
      // Same "must be copied" rule as the consumer page's fromPersisted():
      // live arrivals carry these, history has to be given them explicitly.
      duration_minutes: s.duration_minutes,
      target_reduction_w: s.target_reduction_w,
      auto_push_status: s.auto_pushed ? "sent" : null,
    }));
  const feed: DSMAlert[] = [...alerts, ...storedAsAlerts];

  // ── Per-alert answers ──
  // The stored row is the authority. `PersistedAlert.responses` is the server's
  // own list for that alert, complete however old the alert is; the socket only
  // fills the gap, covering answers that landed since the last hydrate.
  //
  // It used to be the other way round — tallies were built by merging this
  // socket's 100-response cap with a separate 200-row participation window, two
  // windows that could each run out before the feed did, so on a long run the
  // oldest alerts on screen quietly under-reported. Same rule as the summary
  // tiles: a total does not come from an array this page happens to be holding.
  //
  // Deduped on (alert, household): one household gets one vote, which is also
  // what the unique constraint on the table says.
  const responsesByAlertId = new Map<string, DSMResponse[]>();
  const seenResponse = new Set<string>();

  function addResponse(r: DSMResponse) {
    const identity = r.alert_id + "|" + r.user_id;
    if (seenResponse.has(identity)) return;
    seenResponse.add(identity);
    const list = responsesByAlertId.get(r.alert_id);
    if (list) list.push(r);
    else responsesByAlertId.set(r.alert_id, [r]);
  }

  for (const row of stored) {
    for (const s of row.responses) {
      addResponse({
        alert_id: row.alert_id,
        accepted: s.accepted,
        responded_at: s.responded_at,
        user_id: s.user_id,
        username: s.username,
      });
    }
  }
  for (const r of responses) addResponse(r);

  const allResponses: DSMResponse[] = Array.from(responsesByAlertId.values()).flat();

  // No local state to set — every control endpoint broadcasts the new status,
  // which is what re-renders the buttons here and in any other open tab.
  const handleStart = useCallback(async () => {
    await apiStart();
  }, []);

  const handlePause = useCallback(async () => {
    await apiPause();
  }, []);

  const handleResume = useCallback(async () => {
    await apiResume();
  }, []);

  const handleReset = useCallback(async () => {
    setConfirmReset(false);
    // The backend broadcasts system_reset, which is what empties the feeds on
    // this dashboard, every other admin tab, and every consumer phone.
    await apiReset();
  }, []);

  /** Rewind, then run from the top. The only way out of `finished`. */
  const handleRestart = useCallback(async () => {
    await apiReset();
    await apiStart();
  }, []);

  const handleSpeedChange = useCallback(async (value: number) => {
    setSpeed(value);
    await apiSetSpeed(value);
  }, []);

  const handleToggleAutopush = useCallback(async () => {
    setTogglingAutopush(true);
    try {
      // No local state to set — the backend broadcasts autopush_status to every
      // admin client, including this one, which is what flips the switch.
      await apiSetAutopush(!autopushEnabled);
    } catch (err) {
      console.error("Toggle autopush failed:", err);
    }
    setTogglingAutopush(false);
  }, [autopushEnabled]);

  // Auth guard
  useEffect(() => {
    if (!isLoading && (!isAuthenticated || role !== "admin")) {
      router.push("/login");
    }
  }, [isLoading, isAuthenticated, role, router]);

  // Space toggles run/pause — the one action an operator repeats. Guarded so
  // it can never fire from a focused control (Space already activates buttons
  // and toggles switches) or from a text field. No destructive key bindings.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"].includes(el.tagName))
      ) {
        return;
      }
      e.preventDefault();
      if (phase === "running") void apiPause();
      else if (phase === "paused") void apiResume();
      else if (phase === "idle") void apiStart();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase]);

  if (isLoading || !isAuthenticated || role !== "admin") {
    return null;
  }

  // Nobody-has-acted and the-gateway-dropped-it are different states but the
  // same *work*, so the feed's default view holds both.
  //
  // `failedAlerts` stays derived separately because "Resend all failed" acts
  // on exactly that set — an unacted alert has never been tried and is not
  // something to retry.
  const failedAlerts = feed.filter((a) => isFailed(outcomeOf(a)));
  const pendingAlerts = feed.filter((a) => {
    const o = outcomeOf(a);
    return o === null || isFailed(o);
  });

  // What the feed card is showing. "All" is the whole feed in arrival order
  // rather than only the settled remainder — with one card and a filter,
  // hiding pending rows from "All" would make the label a lie.
  const visibleAlerts = (feedView === "pending" ? pendingAlerts : feed).slice(0, 40);

  // The page's headline state, and how many parameters are behind it.
  const verdict = getOperatorVerdict(gridState, phase);
  const tripped = trippedCount(gridState);

  // Only offer confirmation when there is something to lose.
  const hasDataToPurge =
    (status?.current_tick ?? 0) > 0 || alerts.length > 0 || responses.length > 0;

  return (
    <div className="ds-page">
      {/* The rail carries the section nav, the username, sign-out and the
          three live badges this page used to hold in its `aside` — so all that
          is left here is what the page is called. The badges in particular are
          better off there: the gateway being down is the most consequential
          thing an operator can miss, and it used to be invisible from the
          other four screens. */}
      <PageHeader
        title="Control Room"
        subtitle="6-parameter monitoring · Indonesian PLN Grid"
      />

      {/* ── Controls ──
          One primary button per phase, so no combination of buttons can
          describe a state the backend isn't in.

          There is no Stop. Stop and Pause were the same action wearing two
          labels: both halted the tick, both kept `current_tick`, and both
          continued from where they left off (Start after a stop resumed
          mid-dataset exactly as Resume does). The only difference was internal
          — stop cancelled the asyncio task, pause parked it in a 100 ms poll.
          Two buttons for one outcome is an invitation to guess at a difference
          that isn't there. Halting is Pause; rewinding is Reset. `/api/stop`
          still exists and `reset()` still calls `simulator.stop()`. */}
      <div className="ds-toolbar">
        {phase === "idle" && (
          <button className="ds-btn ds-btn--primary" onClick={handleStart}>
            Start
          </button>
        )}
        {phase === "running" && (
          <button
            className="ds-btn ds-btn--primary"
            onClick={handlePause}
            title="Hold at the current tick. Resume continues from here; Reset rewinds to the start."
          >
            Pause
          </button>
        )}
        {phase === "paused" && (
          <button
            className="ds-btn ds-btn--primary"
            onClick={handleResume}
            title="Continue from the tick the run is holding at"
          >
            Resume
          </button>
        )}
        {phase === "finished" && (
          <button
            className="ds-btn ds-btn--primary"
            onClick={handleRestart}
            title="The dataset is exhausted — this rewinds to tick 0 and runs again"
          >
            Restart
          </button>
        )}

        <button
          className="ds-btn"
          onClick={() => (hasDataToPurge ? setConfirmReset(true) : handleReset())}
          title="Rewind to tick 0 and clear every alert feed, on this dashboard and every connected phone"
        >
          Reset
        </button>

        {/* The six numbers that decide what this whole system considers a
            problem. They were reachable only by POSTing to the API. */}
        <button
          className="ds-btn"
          onClick={() => setTuning(true)}
          title="Change what counts as a problem — applies to the running engine"
        >
          <Icon name="sliders" size={16} />
          Thresholds
        </button>

        {/* Put a chosen parameter and severity in front of a real phone on
            demand, rather than waiting for the dataset to produce one. */}
        <button
          className="ds-btn"
          onClick={() => setTesting(true)}
          title="Compose an alert by hand and push it through the gateway — it behaves exactly like a triggered one"
        >
          <Icon name="alerts" size={16} />
          Test alert
        </button>

        <div className="ds-range-group">
          <span className="ds-range-group__label">Speed</span>
          <input
            type="range"
            className="ds-range"
            min={50}
            max={2000}
            step={50}
            aria-label="Tick interval"
            value={2050 - speed}
            onChange={(e) => handleSpeedChange(2050 - Number(e.target.value))}
          />
          <span className="ds-range-group__value">{speed}ms</span>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={autopushEnabled}
          className="ds-switch"
          onClick={handleToggleAutopush}
          disabled={togglingAutopush}
          title={
            autopushEnabled
              ? "Critical and emergency alerts are relayed to the ESP32 automatically. Warnings still need a manual Push."
              : "Every alert waits for a manual Push. Turn on to auto-relay critical and emergency alerts."
          }
        >
          <span className="ds-switch__track">
            <span className="ds-switch__thumb" />
          </span>
          <span className="ds-switch__label">
            Autopush
            <span className="ds-switch__scope">critical+</span>
          </span>
        </button>

        {/* Recovery is one click once the gateway is back, instead of hunting
            the feed for rows that failed while it was down. */}
        {failedAlerts.length > 0 && (
          <button
            className="ds-btn ds-btn--sm"
            onClick={() => failedAlerts.forEach((a) => void pushAlert(a))}
            disabled={!esp32Connected}
            title={
              esp32Connected
                ? "Push every alert that failed to reach the gateway"
                : "The ESP32 gateway is offline — a resend would fail too"
            }
          >
            Resend all failed ({failedAlerts.length})
          </button>
        )}

      </div>

      {/* ── Grid status ──
          The anchor for the page. Six gauges tell an operator what every
          parameter is doing; none of them says whether that adds up to a
          problem, and answering that was previously an act of reading all six
          and holding the trip points in your head.

          Run state rides here rather than in the control strip above. It was
          in the same row as the buttons that change it, which reads well until
          you want to know the state without looking at which button happens to
          be showing — the phase is a fact about the run, not a property of the
          toolbar. */}
      <section className={`ds-hero ds-hero--${verdict.level}`}>
        <div className="ds-hero__main">
          <p className="ds-hero__label">Grid status</p>
          <h2 className="ds-hero__headline">{verdict.headline}</h2>
          <p className="ds-hero__detail">{verdict.detail}</p>
          {verdict.cause && (
            <p className="ds-hero__cause">
              Because {verdict.cause}
              {tripped > 1 && ` · ${tripped} parameters over the line`}.
            </p>
          )}
        </div>

        <div className="ds-hero__run">
          <span className={`ds-statusline__state ds-statusline__state--${phase}`}>
            {PHASE_LABEL[phase]}
          </span>
          {status ? (
            <>
              <span className="ds-hero__tick">
                tick {status.current_tick.toLocaleString()}
                <span> of {status.total_ticks.toLocaleString()}</span>
              </span>
              <div
                className="ds-progress ds-progress--slim"
                role="progressbar"
                aria-valuenow={Math.round(status.progress_pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Run progress"
              >
                <div
                  className="ds-progress__fill"
                  style={{ width: `${status.progress_pct}%` }}
                />
              </div>
              <span className="ds-hero__stamp">
                {status.progress_pct.toFixed(1)}%
                {gridState && ` · ${gridState.timestamp}`}
              </span>
            </>
          ) : (
            <span className="ds-hero__stamp">waiting for the backend…</span>
          )}
        </div>
      </section>

      {/* ── Live grid state ──
          First, and full width. This is an operator console: what the grid is
          doing right now is the page, and these six gauges were previously in
          the right-hand column below five navigation tiles.

          Ordered by PARAMETER_CONFIGS, which is config.PARAMETER_META's
          priority order — so the console reads in the same sequence the
          control logic breaks a severity tie. */}
      <div className="ds-grid ds-grid--6">
        {PARAMETER_CONFIGS.map((config) => {
          const value = gridState ? (gridState.parameters[config.valueKey] as number) : 0;
          const triggered = gridState
            ? (gridState.parameters[config.triggeredKey] as boolean)
            : false;

          return (
            <Metric
              key={config.key}
              label={config.label}
              value={gridState ? config.format(value) : "—"}
              // The *live* trip point, not a hardcoded one. These gauges
              // highlight from the same evaluation that emits the alerts, so
              // the label has to follow the same thresholds or it contradicts
              // the highlight beside it.
              sub={config.thresholdLabel(thresholds)}
              triggered={triggered}
            />
          );
        })}
      </div>

      {/* ── Alert feed | charts ──
          Wider on the left: the feed is the thing with actions on it. The
          savings card that used to sit under it is gone — "Energy saved" was
          rendered three times on this page (a tile, that card, and a chart
          view), all reading one object. The tile links out, the chart plots
          it, and the by-parameter split it carried now lives on
          /admin/participation beside the answers it derives from. */}
      <div className="ds-grid ds-grid--feed">
        <div className="ds-card ds-card--strip ds-card--scroll">
          {/* One card, not two. "Needs action" and "Everything else" were
              stacked cards rendering the same row type, which meant the
              operator read one list as two and the pending card appeared and
              vanished as work arrived — the page reflowed under them.

              The filter is the same segmented control the charts use. Needs
              action stays the default, so the blocking work is still what you
              land on; the difference is that seeing the rest is now one click
              rather than a scroll past it. */}
          <div className="ds-card__head">
            <span className="ds-card__title">Alert feed</span>
            <span className="ds-feedbar">
              <span
                className="ds-segment"
                style={
                  { "--n": 2, "--i": feedView === "pending" ? 0 : 1 } as React.CSSProperties
                }
              >
                <button
                  className="ds-segment__btn"
                  aria-pressed={feedView === "pending"}
                  onClick={() => setFeedView("pending")}
                >
                  Needs action
                  {pendingAlerts.length > 0 && (
                    <span className="ds-segment__count">{pendingAlerts.length}</span>
                  )}
                </button>
                <button
                  className="ds-segment__btn"
                  aria-pressed={feedView === "all"}
                  onClick={() => setFeedView("all")}
                >
                  All
                </button>
              </span>
              <Link href="/admin/alerts" className="ds-card__meta ds-card__meta--link">
                View all →
              </Link>
            </span>
          </div>

          <div className="ds-card__body ds-stack ds-stack--sm">
            {visibleAlerts.length === 0 ? (
              // "Nothing here" and "history still loading" look identical to
              // an operator, and the wrong one is actively misleading — it
              // says nothing has happened when the record simply hasn't
              // arrived yet.
              <div className="ds-empty">
                {!hydrated ? (
                  <>
                    <strong>Loading history…</strong>
                    Restoring the feed from the database.
                  </>
                ) : feedView === "pending" ? (
                  <>
                    <strong>Nothing waiting on you</strong>
                    Alerts needing a Push or an Ignore land here. Switch to All for
                    the ones already settled.
                  </>
                ) : (
                  <>
                    <strong>No alerts yet</strong>
                    Start the simulation to see triggers.
                  </>
                )}
              </div>
            ) : (
              visibleAlerts.map((alert: DSMAlert) => (
                <AlertRow
                  key={keyOf(alert)}
                  alert={alert}
                  outcome={outcomeOf(alert)}
                  isPushing={pushing.has(keyOf(alert))}
                  esp32Connected={esp32Connected}
                  responses={responsesByAlertId.get(alert.id) ?? []}
                  onPush={pushAlert}
                  onIgnore={ignoreAlert}
                  onUndoIgnore={undoIgnore}
                />
              ))
            )}
          </div>
        </div>

        <GridCharts history={history} savings={savings} thresholds={thresholds} />
      </div>

      {/* Approvals, full width. Scoped to accounts that are actually waiting —
          the full account manager lives at /admin/accounts, which now carries
          the same actions, so this panel no longer has to be a second copy of
          it competing for dashboard space. */}
      <AccountsPanel accountsNonce={accountsNonce} />

      {tuning && (
        <ThresholdPanel
          thresholds={thresholds}
          gridState={gridState}
          onClose={() => setTuning(false)}
        />
      )}

      {testing && (
        <TestAlertPanel
          gridState={gridState}
          incentives={incentives}
          onClose={() => setTesting(false)}
          // A composed alert rides no tick, and `broadcast_pushed_alert` goes
          // to consumers only — so without this refetch the operator fires one
          // and watches the feed do nothing.
          onSent={bumpHistory}
        />
      )}

      {confirmReset && (
        <ResetConfirm
          tick={status?.current_tick ?? 0}
          alertCount={alerts.length}
          responseCount={allResponses.length}
          consumerCount={consumerCount}
          onConfirm={handleReset}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
