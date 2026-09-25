/**
 * Wire types shared by the server, the pages and the tests. They describe what
 * crosses the REST and WebSocket boundary.
 */

export type Severity = "info" | "warning" | "critical" | "emergency";
export type Parameter =
  | "emergency"
  | "frequency"
  | "reserve_margin"
  | "peak_load"
  | "renewable"
  | "price";


export interface GridParameters {
  // P1: Peak Load Forecast
  load_forecast_ema: number;
  peak_load_ratio: number;
  peak_load_triggered: boolean;

  // P2: Frequency Deviation
  frequency_hz: number;
  freq_deviation_hz: number;
  freq_deviation_triggered: boolean;

  // P3: Reserve Margin
  neighborhood_demand_kw: number;
  reserve_margin_pct: number;
  spinning_reserve_triggered: boolean;

  // P4: Renewable Forecast
  solar_output_kw: number;
  wind_output_kw: number;
  renewable_fraction: number;
  low_renewable_triggered: boolean;

  // P5: Emergency Condition
  voltage_deviation_pct: number;
  apparent_power_kva: number;
  emergency_score: number;
  emergency_triggered: boolean;

  // P6: Electricity Price
  /**
   * Time-of-use *wholesale* base for this hour. Normal retail is this × 1.35,
   * which is what "spiking" is measured against — the P6 gate is the only
   * relative one, and a fixed rupiah comparison is what made the old price
   * reward wrong at every hour but one.
   */
  tou_base_price_idr: number;
  wholesale_price_idr: number;
  retail_price_idr: number;
  price_spike_triggered: boolean;
}

/**
 * The six live thresholds, from `GET /api/thresholds`.
 *
 * These genuinely steer the engine now. Until recently the control logic
 * branched on the dataset's baked-in `*_triggered` columns and these values
 * were only printed beside an alert, so moving one changed nothing.
 */
export interface Thresholds {
  peak_load_ratio: number;
  freq_deviation_hz: number;
  reserve_margin_critical_pct: number;
  low_renewable_fraction: number;
  emergency_score: number;
  price_spike_ratio: number;
}

export interface RawMeasurements {
  global_active_power: number;
  global_reactive_power: number;
  voltage: number;
  global_intensity: number;
  sub_metering_1: number;
  sub_metering_2: number;
  sub_metering_3: number;
}

export interface GridState {
  tick: number;
  timestamp: string;
  sim_time: string;
  measurements: RawMeasurements;
  parameters: GridParameters;
}

export interface DSMAlert {
  id: string;
  tick: number;
  timestamp: string;
  severity: Severity;
  parameter: string;
  title: string;
  message: string;
  incentive?: string;
  value: number;
  threshold: number;
  /** Machine-readable form of the credit rate quoted in `incentive`. */
  reward_idr_per_kwh?: number | null;
  /**
   * kWh this alert asks the household to drop, from `src/server/grid/incentives.ts`.
   *
   * Computed backend-side and carried on the alert. **Do not re-model it in a
   * client.** It used to be a flat `ASSUMED_REDUCTION_KWH = 1` declared
   * separately in both web pages, the audit routes — four
   * constants with nothing keeping them equal, which paid an emergency
   * contingency and a "shift your laundry" nudge identically.
   */
  expected_shed_kwh?: number;
  /**
   * The same ask as a controller setpoint: hold `target_reduction_w` watts for
   * `duration_minutes`, then restore. Derived backend-side from
   * `expected_shed_kwh` (`throttleSetpoint`) — **not a second
   * model of it**, and not something a client may recompute; both figures are
   * stamped together and a client that re-derives one will drift the moment
   * the window table changes.
   *
   * Absent on alerts written before the throttle model existed, which is why
   * `throttleLine()` in `domain.ts` returns null rather than guessing.
   */
  duration_minutes?: number | null;
  target_reduction_w?: number | null;
  /**
   * Set by backend autopush. Absent/null on normal manual-approval alerts.
   * "esp32_offline" means autopush fired with no gateway attached, so the
   * alert was dropped — fail-closed, same as a manual push would be.
   */
  auto_push_status?: "sent" | "esp32_offline" | null;
}

export interface DSMResponse {
  alert_id: string;
  accepted: boolean;
  responded_at: string;
  /**
   * Which household answered. Carried end-to-end through the ESP32 — the
   * backend fills it from the consumer's access token, the gateway copies it
   * into `forward_response`, and the admin renders what the gateway sent.
   *
   * Responses used to be anonymous, so the admin tally counted answers rather
   * than households and could not tell three phones answering once from one
   * phone answering three times. Empty string only for a response relayed by
   * firmware predating that change.
   */
  user_id: string;
  username: string;
}

// ── Accounts ──

export type UserRole = "admin" | "consumer";
/** `pending` accounts exist but cannot sign in until an operator approves. */
export type UserStatus = "pending" | "active" | "suspended";

/**
 * An account as the API exposes it.
 *
 * There is no password field and there never will be one — only a bcrypt hash
 * is stored, which is one-way. Resetting a password is an action, not a value
 * you can read back.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  created_at?: string | null;
  approved_at?: string | null;
  approved_by_username?: string | null;
  last_login_at?: string | null;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

/** Machine-readable failure reason from the backend, e.g. `account_pending`. */
export interface ApiError {
  code: string;
  message: string;
}

/** One household's answer as the operator sees it in persisted history. */
export interface ResponseSummary {
  user_id: string;
  username: string;
  accepted: boolean;
  responded_at: string;
}

/**
 * What has happened to an alert. Derived on the backend from the timestamp
 * columns (`alertOutcome`) so the dashboard cannot hold a second, disagreeing
 * copy — the bug the admin page already fixed once by collapsing three parallel
 * Sets into one map.
 */
export type AlertOutcome =
  | "pushed"
  | "auto-pushed"
  | "failed-gateway"
  | "ignored";

/**
 * A persisted alert, from `GET /api/alerts` (admin) or `/api/alerts/mine`
 * (consumer). One row per *triggered* alert, not per push attempt.
 *
 * Read the timestamps as a lifecycle: `triggered_at` is always set;
 * `pushed_at` is null until an operator acts; `delivered_at` is null until the
 * ESP32 echoes it back. The consumer endpoint only ever returns alerts with a
 * `delivered_at`, which is what stops history becoming a second delivery path
 * around the gateway.
 */
export interface PersistedAlert {
  id: string;
  alert_id: string;
  tick: number;
  timestamp: string;
  severity: DSMAlert["severity"];
  parameter: string;
  title: string;
  message: string;
  incentive?: string | null;
  value: number;
  threshold: number;
  reward_idr_per_kwh?: number | null;
  expected_shed_kwh?: number;
  /** See `DSMAlert`. Null on rows predating the throttle model. */
  duration_minutes?: number | null;
  target_reduction_w?: number | null;
  triggered_at: string;
  pushed_at?: string | null;
  pushed_by_username?: string | null;
  auto_pushed: boolean;
  push_attempts: number;
  delivered_at?: string | null;
  ignored_at?: string | null;
  /** null means pending — nobody has acted on it yet. */
  outcome?: AlertOutcome | null;
  responses: ResponseSummary[];
  /** This household's own answer. Consumer endpoint only. */
  my_response?: boolean | null;
}

/**
 * One household's answer, flattened for the admin participation log.
 *
 * The `alert_*` fields and the timestamp block below carry the answered alert's
 * own lifecycle, so a row states who was asked what, who asked, and how long
 * the reply took. Reading `responded_at` alone only ever said that somebody
 * tapped something; the rest had to be cross-referenced by hand against the
 * alert history page.
 */
export interface ParticipationEntry {
  id: string;
  alert_id: string;
  alert_title: string;
  alert_severity: DSMAlert["severity"];
  alert_parameter: string;
  alert_message?: string;
  alert_incentive?: string | null;
  tick: number;
  user_id: string;
  username: string;
  accepted: boolean;
  responded_at: string;
  reward_idr_per_kwh?: number | null;
  /** Always set — the moment the control logic emitted the alert. */
  triggered_at?: string | null;
  pushed_at?: string | null;
  /** Absent for an autopush, or when the operator's account has been deleted. */
  pushed_by_username?: string | null;
  auto_pushed?: boolean;
  /** When the ESP32 echoed it back. Response latency is measured from here. */
  delivered_at?: string | null;

  /**
   * What this answer earned, and why — all derived server-side from
   * `src/server/grid/incentives.ts`, so the participation log, the account profile and
   * both consumer clients quote one arithmetic rather than three.
   *
   * A declined answer reports multipliers of 1.0 and zero credit, not what it
   * "would have" been worth.
   */
  expected_shed_kwh?: number;
  /** Gateway delivery → answer. Null when there is no delivery stamp to measure from. */
  latency_seconds?: number | null;
  /** Consecutive accepts including this one. 0 on a decline. */
  streak_at_response?: number;
  response_bonus?: number;
  /** e.g. "within 2 minutes" — the tier's own wording, for explaining the bonus. */
  response_bonus_label?: string | null;
  streak_multiplier?: number;
  credit_idr?: number;
}

// ── Savings ──

/** One slice of the savings total, by severity or by parameter. */
export interface SavingsBucket {
  key: string;
  responses: number;
  kwh: number;
  credit_idr: number;
}

/** A cumulative running total, for the chart. Oldest first. */
export interface SavingsPoint {
  tick: number;
  responded_at: string;
  kwh: number;
  credit_idr: number;
}

/**
 * What accepting alerts is estimated to have saved — `GET /api/savings`
 * (whole programme) or `/api/savings/mine` (one household). One shape and one
 * backend builder, so the operator's card and the household's tab cannot
 * report differently-computed versions of the same number.
 *
 * Modelled, not metered: the simulator replays a fixed recording, so a
 * household's answer cannot move the meter. Say so wherever this is rendered.
 */
export interface SavingsSummary {
  /**
   * What this household was *asked* for, in kWh: every alert the gateway
   * delivered to them, answered or not. The denominator of "you shifted X of
   * the Y kWh you were asked for", which replaced a hardcoded Rp 50,000 goal
   * that was not per-period, not chosen, and pinned at 100% once crossed.
   *
   * kWh rather than rupiah on purpose: credit carries speed and streak
   * multipliers, so a rupiah ratio could exceed 100%.
   *
   * `0` on the operator's `/api/savings` — programme-wide the denominator would
   * be alerts × households, a different quantity — so the admin renders no bar.
   */
  offered_kwh: number;
  offered_alerts: number;
  /**
   * The run of consecutive accepts this household is on, and what it currently
   * multiplies credit by. Server-derived from the stored `streak_at_response`
   * snapshots — a client counting leading accepts in its own feed would be a
   * second model of the streak that could disagree with what was actually paid.
   * `0` / `1` on the operator's `/api/savings`.
   */
  current_streak: number;
  streak_multiplier: number;
  accepted_count: number;
  declined_count: number;
  households: number;
  total_kwh: number;
  total_credit_idr: number;
  by_severity: SavingsBucket[];
  by_parameter: SavingsBucket[];
  series: SavingsPoint[];
}

/**
 * The incentive model itself, from `GET /api/incentives`.
 *
 * Served rather than restated here: the consumer app has to preview what
 * accepting is worth *before* there is a response to ask the server about, and
 * the previous answer to that was a hardcoded constant per client.
 */
export interface IncentiveModel {
  shed_kwh_by_parameter: Record<string, number>;
  shed_multiplier_by_severity: Record<string, number>;
  /**
   * How long the ask is spread over, per severity. With the two above this is
   * everything a client needs to *preview* the setpoint an alert would carry,
   * without restating the backend's tables — see `previewSetpoint` in
   * `domain.ts`.
   */
  throttle_window_minutes_by_severity: Record<string, number>;
  response_bonus_tiers: { max_seconds: number; multiplier: number; label: string }[];
  streak_step: number;
  streak_max_steps: number;
}

/** One entry in the append-only operator audit trail. */
export interface AuditEntry {
  id: string;
  actor_user_id?: string | null;
  actor_label: string;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  /**
   * Snapshot of the target's name at the time of the action. Denormalised so a
   * deleted account is still named here after its row (and the FK) is gone.
   */
  target_label?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  created_at: string;
}

/** Everything the account detail page shows. Still no password anywhere. */
export interface UserProfile {
  user: User;
  accepted_count: number;
  declined_count: number;
  estimated_credit_idr: number;
  total_kwh?: number;
  /**
   * 0–100, from accept rate and median reply speed. Operator-facing only: a
   * score the household can see becomes a thing to game rather than measure.
   */
  reliability_score?: number;
  accept_rate?: number;
  median_latency_seconds?: number | null;
  current_streak?: number;
  recent_responses: ParticipationEntry[];
  recent_audit: AuditEntry[];
}

/** An admin-approved alert delivered outside the regular telemetry tick. */
export interface PushedAlertMessage {
  type: "pushed_alert";
  alert: DSMAlert;
}

/** Tracks an alert + the action the consumer took */
export interface AlertLogEntry {
  alert: DSMAlert;
  action: "accepted" | "declined" | "pending";
  actionAt?: string;
}

/**
 * The one value the controls switch on. `running` + `paused` are two booleans
 * describing a single thing, and `finished` is not expressible in them at all
 * (the loop ends with running=false and the tick at the end of the dataset).
 * Derived on the backend in `Simulator.phase`; the booleans remain in the
 * payload for compatibility but the UI should read `phase`.
 */
export type SimulationPhase = "idle" | "running" | "paused" | "finished";

export interface SimulationStatus {
  running: boolean;
  paused: boolean;
  phase: SimulationPhase;
  current_tick: number;
  total_ticks: number;
  tick_interval_ms: number;
  progress_pct: number;
  current_timestamp?: string;
}

export interface TickMessage {
  type:
    | "tick"
    | "status"
    | "pushed_alert"
    | "dsm_response"
    | "esp32_status"
    | "autopush_status"
    | "client_count"
    | "accounts_changed"
    /** Admin only: the live trip points, on connect and on every retune. */
    | "thresholds"
    /**
     * Consumer only: this household's own answer, echoed back through the
     * gateway so their other devices agree about what has been answered.
     * Carries no alert content.
     */
    | "my_response"
    | "system_reset";
  state?: GridState;
  alerts?: DSMAlert[];
  alert?: DSMAlert;
  /** `status` carries a SimulationStatus; `thresholds` carries a Thresholds. */
  data?: SimulationStatus | Thresholds;
  alert_id?: string;
  accepted?: boolean;
  responded_at?: string;
  /** dsm_response: which household answered, relayed through the gateway. */
  user_id?: string;
  username?: string;
  connected?: boolean;
  enabled?: boolean;
  /** client_count: number of consumer sockets currently attached. */
  consumers?: number;
  /**
   * client_count: number of distinct households behind those sockets. Lower
   * than `consumers` when one person has the app open more than once.
   */
  households?: number;
}

/** Severity ordering, used to pick the loudest severity in a group. */
export const SEVERITY_RANK: Record<DSMAlert["severity"], number> = {
  info: 0,
  warning: 1,
  critical: 2,
  emergency: 3,
};

/**
 * Plain-language statement of what a consumer is actually agreeing to do,
 * keyed by `DSMAlert.parameter`. The alert's own `incentive` text explains the
 * reward; this covers the commitment, which the buttons alone never stated.
 *
 * NOTE: these keys are the backend's `parameter` values from
 * the control logic — "reserve_margin", not PARAMETER_CONFIGS'
 * display key "reserve".
 */
export const PARAMETER_ASKS: Record<string, string> = {
  peak_load:
    "Delay heavy appliances (AC, washing machine, water heater) until demand drops.",
  frequency:
    "Switch off non-essential loads now — the grid needs demand to fall immediately.",
  reserve_margin:
    "Cut back consumption while spare capacity is critically low, to help avoid a blackout.",
  renewable:
    "Shift heavy usage to later, when more solar and wind are on the grid.",
  emergency:
    "Immediately reduce all non-critical loads — this is a grid contingency event.",
  price:
    "Defer heavy usage until the rate comes back down.",
};

/** Fallback when an alert arrives with an unrecognised parameter. */
export const DEFAULT_PARAMETER_ASK =
  "Reduce non-essential electricity usage for a short period.";

// Parameter display configuration (minimalist — no icons or colors)
export interface ParameterConfig {
  /** Display key. Differs from `parameter` for exactly one gauge — see below. */
  key: string;
  /**
   * The backend's own `parameter` value (`PARAMETER_META` key), as it
   * appears on `DSMAlert.parameter` and in `lib/constants.ts` PARAMETERS.
   *
   * Carried here so the correspondence between a gauge and the alerts it
   * explains lives in this table rather than in a per-page lookup. It is only
   * `key` again five times out of six: the reserve gauge is `"reserve"` for
   * display and `"reserve_margin"` on the wire.
   */
  parameter: string;
  label: string;
  unit: string;
  valueKey: keyof GridParameters;
  triggeredKey: keyof GridParameters;
  format: (v: number) => string;
  /**
   * Where this gauge's line currently sits.
   *
   * A function of the *live* thresholds, not a fixed string. These labels used
   * to be hardcoded ("> 1.5×", "< 10%") back when the engine could not be
   * retuned anyway. Now that `POST /api/thresholds` genuinely moves the gate, a
   * literal here would be a claim the engine no longer honours — the gauge
   * would say "> 1.5×" while alerting at 3.0.
   *
   * `null` renders the fallback: the thresholds have not loaded yet.
   */
  thresholdLabel: (t: Thresholds | null) => string;
  /**
   * Which trip point this gauge is measured against, and the range an operator
   * may drag it over.
   *
   * The bounds are editorial, not enforced by the backend — `POST /api/thresholds`
   * takes any float. They exist so the tuning panel offers a range that is
   * *useful* rather than one that is merely legal: a peak-load ratio of 40× can
   * be posted and would simply mean the gate never fires again, which is a way
   * to silence the engine by accident rather than a setting anyone wants.
   */
  tuning: {
    key: keyof Thresholds;
    min: number;
    max: number;
    step: number;
    /** The threshold value on its own, for the slider's readout. */
    format: (v: number) => string;
    /** Which direction trips the gate — the panel says so, because "10%" on
     *  its own does not tell you whether higher or lower is the problem. */
    direction: "above" | "below";
  };
}

/** Defaults mirror `THRESHOLDS` in src/server/grid/constants.ts, for rendering before the fetch lands. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  peak_load_ratio: 1.5,
  freq_deviation_hz: 0.2,
  reserve_margin_critical_pct: 10.0,
  low_renewable_fraction: 0.15,
  emergency_score: 0.6,
  price_spike_ratio: 2.0,
};

const at = (t: Thresholds | null) => t ?? DEFAULT_THRESHOLDS;

/**
 * The six gauges, ordered the way the engine ranks them.
 *
 * This is `PARAMETER_META`'s priority order — emergency, frequency,
 * reserve, peak load, renewables, price — not an arbitrary display order. The
 * operator's console reads top-left to bottom-right in the same sequence the
 * control logic breaks a severity tie, so "which of these two lit gauges won"
 * is answerable by position.
 *
 * NOTE `key` is the *display* key ("reserve"), which is not the backend's
 * `parameter` value ("reserve_margin") used by PARAMETER_ASKS above.
 */
export const PARAMETER_CONFIGS: ParameterConfig[] = [
  {
    key: "emergency",
    parameter: "emergency",
    label: "Emergency Score",
    unit: "score",
    valueKey: "emergency_score",
    triggeredKey: "emergency_triggered",
    format: (v) => v.toFixed(3),
    thresholdLabel: (t) => `> ${at(t).emergency_score}`,
    tuning: {
      key: "emergency_score",
      min: 0.1,
      max: 0.95,
      step: 0.05,
      format: (v) => v.toFixed(2),
      direction: "above",
    },
  },
  {
    key: "frequency",
    parameter: "frequency",
    label: "Grid Frequency",
    unit: "Hz",
    valueKey: "frequency_hz",
    triggeredKey: "freq_deviation_triggered",
    format: (v) => v.toFixed(3) + " Hz",
    thresholdLabel: (t) => `±${at(t).freq_deviation_hz} Hz`,
    tuning: {
      key: "freq_deviation_hz",
      min: 0.05,
      max: 0.6,
      step: 0.05,
      format: (v) => `±${v.toFixed(2)} Hz`,
      direction: "above",
    },
  },
  {
    key: "reserve",
    parameter: "reserve_margin",
    label: "Reserve Margin",
    unit: "%",
    valueKey: "reserve_margin_pct",
    triggeredKey: "spinning_reserve_triggered",
    format: (v) => v.toFixed(1) + "%",
    thresholdLabel: (t) => `< ${at(t).reserve_margin_critical_pct}%`,
    tuning: {
      key: "reserve_margin_critical_pct",
      min: 2,
      max: 30,
      step: 1,
      format: (v) => `${v.toFixed(0)}%`,
      direction: "below",
    },
  },
  {
    key: "peak_load",
    parameter: "peak_load",
    label: "Peak Load",
    unit: "× forecast",
    valueKey: "peak_load_ratio",
    triggeredKey: "peak_load_triggered",
    format: (v) => v.toFixed(2) + "×",
    thresholdLabel: (t) => `> ${at(t).peak_load_ratio}×`,
    tuning: {
      key: "peak_load_ratio",
      min: 1.1,
      max: 4,
      step: 0.1,
      format: (v) => `${v.toFixed(1)}×`,
      direction: "above",
    },
  },
  {
    key: "renewable",
    parameter: "renewable",
    label: "Renewables",
    unit: "%",
    valueKey: "renewable_fraction",
    triggeredKey: "low_renewable_triggered",
    format: (v) => (v * 100).toFixed(1) + "%",
    thresholdLabel: (t) => `< ${(at(t).low_renewable_fraction * 100).toFixed(0)}%`,
    // Stored as a fraction but tuned as a percentage — nobody reasons about
    // "0.15 of the grid". The panel converts on the way in and out.
    tuning: {
      key: "low_renewable_fraction",
      min: 0.05,
      max: 0.6,
      step: 0.05,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      direction: "below",
    },
  },
  {
    key: "price",
    parameter: "price",
    label: "Retail Price",
    unit: "IDR/kWh",
    valueKey: "retail_price_idr",
    triggeredKey: "price_spike_triggered",
    format: (v) => "Rp " + Math.round(v).toLocaleString(),
    // Relative, so this one names the multiple rather than a rupiah figure —
    // the actual trip point moves with the time-of-use base every hour.
    thresholdLabel: (t) => `> ${at(t).price_spike_ratio}× normal`,
    tuning: {
      key: "price_spike_ratio",
      min: 1.1,
      max: 4,
      step: 0.1,
      format: (v) => `${v.toFixed(1)}× normal`,
      direction: "above",
    },
  },
];
