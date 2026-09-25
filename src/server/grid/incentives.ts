/**
 * The incentive model: what an alert asks for and what answering it is worth.
 *
 * Everything here is a *model*. The simulator replays a fixed recording, so a
 * household tapping Accept cannot move the meter. Every kWh is what the alert
 * asked for and every rupiah is an estimate of the credit that would follow.
 * Both clients say so on screen.
 *
 * Four inputs:
 *   shed    how much load the alert asks for (parameter × severity)
 *   rate    Rp/kWh, set per parameter by the control logic
 *   speed   answering within minutes of delivery pays more
 *   streak  consecutive accepts pay more, capped
 *
 * Credit is derived on read. Streak is stored as a snapshot on the response
 * row, because responses can be changed later and recomputing would rewrite history.
 */

import type { Severity } from "@/lib/types";
import {
  DEFAULT_THROTTLE_WINDOW_MINUTES,
  PARAMETER_META,
  THROTTLE_WINDOW_MINUTES_BY_SEVERITY,
} from "./constants";
import { pyRound } from "./pyround";

// ── Shed: how much load the alert asks for ────────────────────────────────────

export const SHED_KWH_BY_PARAMETER: Record<string, number> = Object.fromEntries(
  Object.entries(PARAMETER_META).map(([k, v]) => [k, v.shed_kwh]),
);

// An alert with a parameter this table doesn't know behaves like the old flat
// model rather than silently paying zero.
export const DEFAULT_SHED_KWH = 1.0;

export const SHED_MULTIPLIER_BY_SEVERITY: Record<Severity, number> = {
  emergency: 1.5,
  critical: 1.25,
  warning: 1.0,
  info: 1.0,
};

/** kWh this alert asks the household to drop. Stamped onto the alert when it is built. */
export function expectedShedKwh(parameter: string, severity: string): number {
  const base = SHED_KWH_BY_PARAMETER[parameter] ?? DEFAULT_SHED_KWH;
  const mult = SHED_MULTIPLIER_BY_SEVERITY[severity as Severity] ?? 1.0;
  return pyRound(base * mult, 3);
}

// ── Throttle: the same ask as a power setpoint a controller can enforce ──────

/** How long the alert's ask is spread over, in real minutes. */
export function throttleWindowMinutes(severity: string): number {
  return THROTTLE_WINDOW_MINUTES_BY_SEVERITY[severity as Severity] ?? DEFAULT_THROTTLE_WINDOW_MINUTES;
}

/**
 * Watts to hold for `durationMinutes` to shed `shedKwh`. A bad window asks for
 * nothing rather than for infinity.
 */
export function throttleSetpoint(shedKwh: number, durationMinutes: number): number {
  if (durationMinutes <= 0) return 0.0;
  return pyRound((shedKwh * 60_000.0) / durationMinutes, 3);
}

/** The inverse, used only when an operator types watts for a composed test alert. */
export function shedFromSetpoint(targetReductionW: number, durationMinutes: number): number {
  if (durationMinutes <= 0) return 0.0;
  return pyRound((targetReductionW * durationMinutes) / 60_000.0, 3);
}

// ── Speed: answering while it still helps ────────────────────────────────────

// Fastest first; the first tier the latency fits wins. Latency is measured from
// the gateway's delivery, never from the trigger, so an operator's delay in
// pushing never counts against the household.
export const RESPONSE_BONUS_TIERS: ReadonlyArray<readonly [number, number, string]> = [
  [120.0, 1.25, "within 2 minutes"],
  [300.0, 1.1, "within 5 minutes"],
];
export const RESPONSE_BONUS_BASE = 1.0;

export function responseBonus(latencySeconds: number | null | undefined): number {
  if (latencySeconds == null || latencySeconds < 0) return RESPONSE_BONUS_BASE;
  for (const [cutoff, multiplier] of RESPONSE_BONUS_TIERS) {
    if (latencySeconds <= cutoff) return multiplier;
  }
  return RESPONSE_BONUS_BASE;
}

export function responseBonusLabel(latencySeconds: number | null | undefined): string | null {
  if (latencySeconds == null || latencySeconds < 0) return null;
  for (const [cutoff, , label] of RESPONSE_BONUS_TIERS) {
    if (latencySeconds <= cutoff) return label;
  }
  return null;
}

// ── Streak: consecutive accepts ──────────────────────────────────────────────

export const STREAK_STEP = 0.05;
export const STREAK_MAX_STEPS = 5; // caps the multiplier at 1.25×

/** `streak` counts this accept too, so a first accept (1) earns no bonus. */
export function streakMultiplier(streak: number): number {
  if (streak <= 1) return 1.0;
  return pyRound(1.0 + Math.min(streak - 1, STREAK_MAX_STEPS) * STREAK_STEP, 4);
}

// ── Putting it together ──────────────────────────────────────────────────────

/** What one accepted alert is estimated to be worth, in rupiah. */
export function creditIdr(
  rewardIdrPerKwh: number | null | undefined,
  shedKwh: number | null | undefined,
  latencySeconds: number | null = null,
  streak = 0,
): number {
  const rate = rewardIdrPerKwh || 0.0;
  const shed = shedKwh ? shedKwh : DEFAULT_SHED_KWH;
  const total = rate * shed * responseBonus(latencySeconds) * streakMultiplier(streak);
  return pyRound(total, 2);
}

/** Seconds from delivery to answer, or null when there's nothing honest to report. */
export function latencySeconds(
  deliveredAt: Date | null | undefined,
  respondedAt: Date | null | undefined,
): number | null {
  if (!deliveredAt || !respondedAt) return null;
  const seconds = (respondedAt.getTime() - deliveredAt.getTime()) / 1000;
  return seconds >= 0 ? seconds : null;
}

// ── Reliability: the operator's view of a household ──────────────────────────

// A fast "no" sheds nothing, so saying yes counts for more than speed.
export const RELIABILITY_ACCEPT_WEIGHT = 0.7;
export const RELIABILITY_SPEED_WEIGHT = 0.3;
export const RELIABILITY_SPEED_TARGET_S = 120.0;
export const RELIABILITY_SPEED_FLOOR_S = 900.0;

/** 0–100, for ranking which households the operator can count on. */
export function reliability(acceptRate: number, medianLatencyS: number | null): number {
  const accept = Math.max(0.0, Math.min(acceptRate, 1.0));
  if (medianLatencyS == null) return pyRound(accept * 100);

  let speed: number;
  if (medianLatencyS <= RELIABILITY_SPEED_TARGET_S) speed = 1.0;
  else if (medianLatencyS >= RELIABILITY_SPEED_FLOOR_S) speed = 0.0;
  else {
    const span = RELIABILITY_SPEED_FLOOR_S - RELIABILITY_SPEED_TARGET_S;
    speed = 1.0 - (medianLatencyS - RELIABILITY_SPEED_TARGET_S) / span;
  }
  return pyRound((RELIABILITY_ACCEPT_WEIGHT * accept + RELIABILITY_SPEED_WEIGHT * speed) * 100);
}
