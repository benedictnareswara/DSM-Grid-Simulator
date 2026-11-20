/** Wire types shared by the server, the pages and the tests. */

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
  /** Time-of-use *wholesale* base for this hour. */
  tou_base_price_idr: number;
  wholesale_price_idr: number;
  retail_price_idr: number;
  price_spike_triggered: boolean;
}

/** The six live thresholds, from `GET /api/thresholds`. */
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
  /** kWh this alert asks the household to drop, from `src/server/grid/incentives.ts`. */
  expected_shed_kwh?: number;
  /**
   * The same ask as a controller setpoint: hold `target_reduction_w` watts for `duration_minutes`,
   * then restore.
   */
  duration_minutes?: number | null;
  target_reduction_w?: number | null;
  /** Set by backend autopush. */
  auto_push_status?: "sent" | "esp32_offline" | null;
}

export interface DSMResponse {
  alert_id: string;
  accepted: boolean;
  responded_at: string;
  /** Which household answered. */
  user_id: string;
  username: string;
}

// ── Accounts ──

export type UserRole = "admin" | "consumer";
/** `pending` accounts exist but cannot sign in until an operator approves. */
export type UserStatus = "pending" | "active" | "suspended";

/** An account as the API exposes it. */
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

/** What has happened to an alert. */
export type AlertOutcome =
  | "sending" // pushed to the gateway, its delivery echo not back yet (see DELIVERY_GRACE_MS)
  | "pushed"
  | "auto-pushed"
  | "failed-gateway"
  | "ignored";

/** A persisted alert, from `GET /api/alerts` (admin) or `/api/alerts/mine` (consumer). */
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

/** One household's answer, flattened for the admin participation log. */
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
   * `src/server/grid/incentives.ts`, so the participation log, the account profile and both
   * consumer clients quote one arithmetic rather than three.
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
 * What accepting alerts is estimated to have saved — `GET /api/savings` (whole programme) or
 * `/api/savings/mine` (one household).
 */
export interface SavingsSummary {
  /**
   * What this household was *asked* for, in kWh: every alert the gateway delivered to them,
   * answered or not.
   */
  offered_kwh: number;
  offered_alerts: number;
  /**
   * The run of consecutive accepts this household is on, and what it currently multiplies credit
   * by.
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

/** The incentive model itself, from `GET /api/incentives`. */
export interface IncentiveModel {
  shed_kwh_by_parameter: Record<string, number>;
  shed_multiplier_by_severity: Record<string, number>;
  /** How long the ask is spread over, per severity. */
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
  /** Snapshot of the target's name at the time of the action. */
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
  /** 0–100, from accept rate and median reply speed. */
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
  /** Whether this household's answer has made it through the gateway. */
  delivery?: "sending" | "failed";
  failedAction?: "accepted" | "declined";
}

/** The one value the controls switch on. */
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
    | "alert_delivered"
    /** Admin only: the live trip points, on connect and on every retune. */
    | "thresholds"
    /**
     * Consumer only: this household's own answer, echoed back through the gateway so their other
     * devices agree about what has been answered.
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
  /** client_count: number of distinct households behind those sockets. */
  households?: number;
}

/**
 * Plain-language statement of what a consumer is actually agreeing to do, keyed by
 * `DSMAlert.parameter`.
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
   * The backend's own `parameter` value (`PARAMETER_META` key), as it appears on
   * `DSMAlert.parameter` and in `lib/constants.ts` PARAMETERS.
   */
  parameter: string;
  label: string;
  unit: string;
  valueKey: keyof GridParameters;
  triggeredKey: keyof GridParameters;
  format: (v: number) => string;
  /** Where this gauge's line currently sits. */
  thresholdLabel: (t: Thresholds | null) => string;
  /**
   * Which trip point this gauge is measured against, and the range an operator may drag it over.
   */
  tuning: {
    key: keyof Thresholds;
    min: number;
    max: number;
    step: number;
    /** The threshold value on its own, for the slider's readout. */
    format: (v: number) => string;
    /**
     * Which direction trips the gate — the panel says so, because "10%" on its own does not tell
     * you whether higher or lower is the problem.
     */
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

/** The six gauges, ordered the way the engine ranks them. */
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
    // Stored as a fraction but tuned as a percentage — nobody reasons about "0.15 of the grid".
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
    // Relative, so this one names the multiple rather than a rupiah figure — the actual trip point
    // moves with the time-of-use base every hour.
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
