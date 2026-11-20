/** Simulation, threshold and alert constants. */

import { DEFAULT_THRESHOLDS, type Parameter, type Severity, type Thresholds } from "@/lib/types";

// ── Simulation speed ──────────────────────────────────────────────────────────
export const DEFAULT_TICK_INTERVAL_MS = 1000; // one dataset row (one minute) per second
export const MIN_TICK_INTERVAL_MS = 50;
export const MAX_TICK_INTERVAL_MS = 5000;

// ── Thresholds (defaults; POST /api/thresholds changes them live) ─────────────
// One copy, shared with the pages so they can render before the fetch lands.
export const THRESHOLDS: Readonly<Thresholds> = DEFAULT_THRESHOLDS;

export type ThresholdKey = keyof Thresholds;

// Retail = wholesale × this.
export const RETAIL_MARGIN = 1.35;

// Where a parameter escalates from its base severity to the tier above.
export const SEVERITY_ESCALATION = {
  peak_load: 2.0, // ratio: critical above, warning below
  frequency: 0.5, // |Hz|: emergency above, critical below
  reserve_margin: 5.0, // %: emergency BELOW, critical above
  emergency: 0.8, // score: emergency above, critical below
} as const;

// ── Severities ────────────────────────────────────────────────────────────────
export const SEVERITIES: readonly Severity[] = ["info", "warning", "critical", "emergency"];

export const SEVERITY_PRIORITY: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
  emergency: 3,
};

// After a parameter fires it is quiet for this many ticks (one tick = one simulated minute).
export const ALERT_COOLDOWN_TICKS = 300;
export const COOLDOWN_TICKS_BY_SEVERITY: Record<Severity, number> = {
  emergency: 60,
  critical: 120,
  warning: 300,
  info: 600,
};

// How long an alert's energy ask is spread over, in real minutes.
export const THROTTLE_WINDOW_MINUTES_BY_SEVERITY: Record<Severity, number> = {
  emergency: 60,
  critical: 90,
  warning: 120,
  info: 180,
};
export const DEFAULT_THROTTLE_WINDOW_MINUTES = 120;

// ── Autopush ──────────────────────────────────────────────────────────────────
// Autopush removes the operator's click, not the gateway gate: delivery still completes only when
// the gateway echoes forward_alert back.
export const AUTOPUSH_DEFAULT_ENABLED = false;
export const AUTOPUSH_MIN_SEVERITY: Severity = "critical";

// ── Parameter importance: one table, one order ───────────────────────────────
// priority breaks ties within a severity band (higher wins) reward_idr_per_kwh what a household is
// paid per kWh shifted (price: computed live) shed_kwh base energy ask before the severity
// multiplier priority ranks urgency, shed_kwh ranks the size of the ask, so they don't have to
// agree: price asks for more than renewable while being less urgent.
export const PARAMETER_META: Record<
  Parameter,
  { priority: number; reward_idr_per_kwh: number | null; shed_kwh: number }
> = {
  emergency: { priority: 6, reward_idr_per_kwh: 2000, shed_kwh: 2.0 },
  frequency: { priority: 5, reward_idr_per_kwh: 1500, shed_kwh: 1.8 },
  reserve_margin: { priority: 4, reward_idr_per_kwh: 1200, shed_kwh: 1.5 },
  peak_load: { priority: 3, reward_idr_per_kwh: 500, shed_kwh: 1.2 },
  renewable: { priority: 2, reward_idr_per_kwh: 300, shed_kwh: 0.6 },
  price: { priority: 1, reward_idr_per_kwh: null, shed_kwh: 0.8 },
};

export const PARAMETERS = Object.keys(PARAMETER_META) as Parameter[];
