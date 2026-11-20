/** Consumer-facing domain logic: presentation only. */

import type { GridState, DSMAlert, IncentiveModel } from "./types";

/** How much of what a household was asked for they actually shifted, 0–1. */
export function capturedFraction(
  summary: { total_kwh: number; offered_kwh: number } | null
): number | null {
  if (!summary || summary.offered_kwh <= 0) return null;
  // Clamped: a household cannot shift more than it was asked for, but a response predating the shed
  // model could still round past the denominator.
  return Math.min(summary.total_kwh / summary.offered_kwh, 1);
}

/** What accepting this alert is worth *before* answering, in rupiah. */
export function estimatedCredit(alert: DSMAlert): number {
  return Math.round((alert.reward_idr_per_kwh ?? 0) * (alert.expected_shed_kwh ?? 0));
}

/** The kWh this alert asks for. Zero when an older alert predates the model. */
export function shedKwh(alert: DSMAlert): number {
  return alert.expected_shed_kwh ?? 0;
}

/** The best speed bonus still available, for nudging a household to answer now. */
export function topSpeedBonus(
  model: IncentiveModel | null
): { multiplier: number; label: string } | null {
  const best = model?.response_bonus_tiers?.[0];
  return best ? { multiplier: best.multiplier, label: best.label } : null;
}

/** "1.25×" — trailing zeros dropped, because "1.10×" reads as more precision than this has. */
export function multiplier(value: number | null | undefined): string {
  if (!value || value === 1) return "";
  return `${Number(value.toFixed(2))}×`;
}

/** "47s", "2m 3s", "1h 4m". Shared by the consumer tab and the admin log. */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** kWh, at a resolution the model can actually support. */
export function kwh(n: number): string {
  return n.toFixed(2);
}

/** How strongly the household is being asked to act, worst-first. */
export type VerdictLevel = "good" | "ease" | "cut" | "unknown";

/** The household-facing read on the grid: what to do, and why. */
export interface Verdict {
  level: VerdictLevel;
  headline: string;
  detail: string;
  /** Which condition put the grid in this state, in household language. */
  cause: string | null;
}

/** The triggered conditions, in the order the engine ranks them. */
const CAUSE_LABELS: [keyof GridState["parameters"], string][] = [
  ["emergency_triggered", "the grid is in a contingency state"],
  ["freq_deviation_triggered", "grid frequency is off its target"],
  ["spinning_reserve_triggered", "spare capacity is running low"],
  ["peak_load_triggered", "demand is above forecast"],
  ["low_renewable_triggered", "very little clean energy is on the grid"],
  ["price_spike_triggered", "the rate is spiking"],
];

/**
 * The flags each verdict level switches on, so a cause can only ever be drawn from the branch that
 * actually fired.
 */
const CAUSE_KEYS_BY_LEVEL: Record<"cut" | "ease", (keyof GridState["parameters"])[]> = {
  cut: ["emergency_triggered", "spinning_reserve_triggered"],
  ease: ["freq_deviation_triggered", "peak_load_triggered", "price_spike_triggered"],
};

/** The highest-priority *relevant* condition currently firing, named. */
function causeFor(
  p: GridState["parameters"],
  allow?: (keyof GridState["parameters"])[]
): string | null {
  const hit = CAUSE_LABELS.find(
    ([key]) => Boolean(p[key]) && (!allow || allow.includes(key))
  );
  return hit ? hit[1] : null;
}

/** The one question this app exists to answer: is right now a good time to use power? */
export function getVerdict(state: GridState | null): Verdict {
  if (!state?.parameters) {
    return {
      level: "unknown",
      headline: "Connecting…",
      detail: "Waiting for live readings from the grid.",
      cause: null,
    };
  }
  const p = state.parameters;

  if (p.emergency_triggered || p.spinning_reserve_triggered) {
    return {
      level: "cut",
      headline: "Cut usage now",
      detail:
        "The grid is running short of spare capacity. Switch off anything you don't need — this is when it matters most.",
      cause: causeFor(p, CAUSE_KEYS_BY_LEVEL.cut),
    };
  }
  if (p.peak_load_triggered || p.price_spike_triggered || p.freq_deviation_triggered) {
    return {
      level: "ease",
      headline: "Ease off if you can",
      detail:
        "Demand is high right now. Holding back the AC, washing machine or water heater for an hour helps, and costs less.",
      cause: causeFor(p, CAUSE_KEYS_BY_LEVEL.ease),
    };
  }
  return {
    level: "good",
    headline: "Good time to use power",
    detail: "The grid has plenty of headroom. Run heavy appliances now if you need to.",
    // Unrestricted, and safe: this branch is reachable only when none of the five flags above are
    // set, so low renewables is the only cause left.
    cause: causeFor(p),
  };
}

/** Thousands separators. */
export function idr(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A whole number of hours reads as hours; anything else stays in minutes. */
function durationPhrase(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${Math.round(minutes)} min`;
}

/** The alert's ask as a load-controller setpoint — "~600 W for 2 hours". */
export function throttleLine(alert: DSMAlert): string | null {
  const watts = alert.target_reduction_w;
  const minutes = alert.duration_minutes;
  if (watts == null || minutes == null || watts <= 0 || minutes <= 0) return null;
  return `~${idr(watts)} W for ${durationPhrase(minutes)}`;
}

/**
 * What setpoint an alert of this kind *would* carry — for the admin's test-alert panel, which has
 * to show the operator a number before the alert exists.
 */
export function previewSetpoint(
  model: IncentiveModel | null,
  parameter: string,
  severity: string,
  durationMinutes: number
): { shedKwh: number; watts: number } | null {
  if (!model || durationMinutes <= 0) return null;
  const base = model.shed_kwh_by_parameter[parameter];
  if (base == null) return null;
  const shedKwh =
    Math.round(base * (model.shed_multiplier_by_severity[severity] ?? 1) * 1000) / 1000;
  return {
    shedKwh,
    watts: Math.round(((shedKwh * 60_000) / durationMinutes) * 1000) / 1000,
  };
}

/** The backend's default window for a severity, or null if the model isn't loaded. */
export function defaultWindowMinutes(
  model: IncentiveModel | null,
  severity: string
): number | null {
  return model?.throttle_window_minutes_by_severity[severity] ?? null;
}
