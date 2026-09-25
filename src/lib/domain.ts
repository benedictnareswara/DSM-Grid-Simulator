/**
 * Consumer-facing domain logic: presentation only.
 *
 * What's missing is deliberate. The credit arithmetic lives in
 * src/server/grid/incentives.ts alone: the shed is stamped onto the alert, the
 * earned multipliers come back on the response, and the totals come from
 * `/api/savings`. What's left here is presentation, plus the one preview a
 * client can't ask the server for: it happens before there's a response.
 */

import type { GridState, DSMAlert, IncentiveModel } from "./types";

/**
 * How much of what a household was asked for they actually shifted, 0–1.
 *
 * This replaced `SAVINGS_GOAL_IDR = 50000` — a hardcoded rupiah target with
 * nothing behind it. It was not per-period, not chosen by anyone, and never
 * reset, so crossing it once pinned the bar at 100% for the life of the
 * account and the "goal" stopped meaning anything.
 *
 * The ratio is on **kWh, not rupiah**: credit carries the speed and streak
 * multipliers, so a rupiah ratio could exceed 100% and "you captured 130% of
 * what was offered" is not a sentence. Energy is what the programme exists to
 * move and is untouched by the multipliers.
 *
 * `null` when nothing has been asked yet — there is no ratio to show, and 0/0
 * rendered as 0% would read as a failure rather than as an empty start.
 */
export function capturedFraction(
  summary: { total_kwh: number; offered_kwh: number } | null
): number | null {
  if (!summary || summary.offered_kwh <= 0) return null;
  // Clamped: a household cannot shift more than it was asked for, but a
  // response predating the shed model could still round past the denominator.
  return Math.min(summary.total_kwh / summary.offered_kwh, 1);
}

/**
 * What accepting this alert is worth *before* answering, in rupiah.
 *
 * Rate × shed, both stamped on the alert by the backend. Deliberately excludes
 * the speed and streak multipliers: neither is earned yet, and quoting a figure
 * the household then misses by replying slowly would be a worse experience than
 * quoting the floor and paying more.
 */
export function estimatedCredit(alert: DSMAlert): number {
  return Math.round((alert.reward_idr_per_kwh ?? 0) * (alert.expected_shed_kwh ?? 0));
}

/** The kWh this alert asks for. Zero when an older alert predates the model. */
export function shedKwh(alert: DSMAlert): number {
  return alert.expected_shed_kwh ?? 0;
}

/**
 * The best speed bonus still available, for nudging a household to answer now.
 *
 * Read off `GET /api/incentives` rather than restated here, so the tiers cannot
 * drift from the ones the backend will actually pay.
 */
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

/**
 * kWh, at a resolution the model can actually support.
 *
 * Two decimals: these are modelled figures with one or two significant digits
 * of real information, and printing 1.7538 kWh would imply a meter reading.
 */
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
  /**
   * Which condition put the grid in this state, in household language.
   *
   * A verdict tells someone what to do; being asked to change your behaviour
   * without being told why is the part that makes an app like this feel
   * arbitrary. `null` when nothing is triggered — "good time to use power" has
   * no cause to name.
   */
  cause: string | null;
}

/**
 * The triggered conditions, in the order the engine ranks them.
 *
 * Same priority as `config.PARAMETER_META`, so when several fire at once the
 * household is told about the one the operator would act on first.
 */
const CAUSE_LABELS: [keyof GridState["parameters"], string][] = [
  ["emergency_triggered", "the grid is in a contingency state"],
  ["freq_deviation_triggered", "grid frequency is off its target"],
  ["spinning_reserve_triggered", "spare capacity is running low"],
  ["peak_load_triggered", "demand is above forecast"],
  ["low_renewable_triggered", "very little clean energy is on the grid"],
  ["price_spike_triggered", "the rate is spiking"],
];

/**
 * The flags each verdict level switches on, so a cause can only ever be drawn
 * from the branch that actually fired.
 *
 * Priority order alone is not enough. `low_renewable_triggered` is in neither
 * branch below — it is the one `info`-capable gate and deliberately does not
 * change the advice — but it now outranks `price_spike_triggered`. Picking the
 * cause by raw priority would render "Ease off if you can … because very
 * little clean energy is on the grid" on any low-renewable night with a price
 * spike, which is most of them: the reason contradicting the verdict it is
 * supposed to explain.
 */
const CAUSE_KEYS_BY_LEVEL: Record<"cut" | "ease", (keyof GridState["parameters"])[]> = {
  cut: ["emergency_triggered", "spinning_reserve_triggered"],
  ease: ["freq_deviation_triggered", "peak_load_triggered", "price_spike_triggered"],
};

/**
 * The highest-priority *relevant* condition currently firing, named.
 *
 * `allow` restricts the search to the flags the firing branch switches on, so
 * the reason can never disagree with the verdict it explains. Passing no
 * `allow` searches everything, which is only correct in the `good` branch —
 * reachable solely when none of the five above are set, leaving low renewables
 * as the only possible answer.
 */
function causeFor(
  p: GridState["parameters"],
  allow?: (keyof GridState["parameters"])[]
): string | null {
  const hit = CAUSE_LABELS.find(
    ([key]) => Boolean(p[key]) && (!allow || allow.includes(key))
  );
  return hit ? hit[1] : null;
}

/**
 * The one question this app exists to answer: is right now a good time to use
 * power? Same triggers the operator sees, resolved into an instruction rather
 * than a reading — a household cannot act on "reserve margin 8.4%".
 *
 * The `*_triggered` flags it reads are evaluated against the operator's *live*
 * thresholds (backend `ControlLogic.triggers`), so this verdict moves when the
 * operator retunes the grid rather than staying pinned to the dataset's
 * transform-time answers.
 */
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
    // Unrestricted, and safe: this branch is reachable only when none of the
    // five flags above are set, so low renewables is the only cause left. It
    // can be non-null — informational, does not change the advice, still worth
    // saying.
    cause: causeFor(p),
  };
}

/**
 * Thousands separators. `Number.toLocaleString()` is unreliable on React
 * Native — Android's Hermes build ships without full ICU, so it silently
 * returns an ungrouped string. Every rupiah figure in this app goes through
 * here instead.
 */
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

/**
 * The alert's ask as a load-controller setpoint — "~600 W for 2 hours".
 *
 * The same quantity as `expected_shed_kwh`, in the form the upcoming throttle
 * will actually enforce. Both are stamped backend-side by
 * `incentives.throttle_setpoint()` and travel together; this only formats, and
 * must not derive one figure from the other (see `DSMAlert`).
 *
 * Returns null when either field is missing — alerts written before the
 * throttle model have neither, and inventing a window for them would put a
 * number in front of a household that nobody ever asked of them.
 */
export function throttleLine(alert: DSMAlert): string | null {
  const watts = alert.target_reduction_w;
  const minutes = alert.duration_minutes;
  if (watts == null || minutes == null || watts <= 0 || minutes <= 0) return null;
  return `~${idr(watts)} W for ${durationPhrase(minutes)}`;
}

/**
 * What setpoint an alert of this kind *would* carry — for the admin's
 * test-alert panel, which has to show the operator a number before the alert
 * exists.
 *
 * Reads the model the backend serves (`GET /api/incentives`) rather than
 * restating its tables, which is the whole reason that endpoint exists. The
 * arithmetic is the one line of `incentives.throttle_setpoint`; the inputs are
 * all the server's.
 *
 * A preview only. The composed alert's real figures are stamped backend-side,
 * and the panel sends `target_reduction_w` only if the operator overrode it.
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
