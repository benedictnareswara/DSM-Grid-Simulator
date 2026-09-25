import type { GridState, SimulationPhase } from "@/lib/types";

/**
 * The one-line state of the grid, for the operator.
 *
 * ## Why this is not in lib/domain.ts
 *
 * `domain.ts` already has `getVerdict()`, which answers the same question for
 * a *household* ("Good time to use power"). This one is operator-only, so it
 * lives next to the admin pages that use it.
 *
 * ## Why the wording differs from the consumer's
 *
 * The household verdict is advice: it says what to *do*, and it is deliberately
 * reassuring at the calm end. This one is a status: it names the condition and
 * the parameter responsible, because the operator's next action is to decide
 * whether to push an alert about it. "Ease off if you can" is useless to
 * someone holding the push button.
 *
 * The severity ordering matches `PARAMETER_META` priority on the
 * server — emergency, frequency, reserve margin, peak load, renewable, price
 * — so the headline names the same condition the engine would rank first if
 * several tripped at once.
 */

export type GridLevel = "unknown" | "stable" | "watch" | "strained" | "contingency";

/** The one-line read on grid health shown above the operator's gauges. */
export interface OperatorVerdict {
  level: GridLevel;
  /** The state, in two or three words. */
  headline: string;
  /** What it means for the programme, in one sentence. */
  detail: string;
  /** Which parameter is responsible, or null when nothing is tripping. */
  cause: string | null;
}

/**
 * No readings. The right next action depends on why, so the copy branches on
 * the run phase rather than always saying "start the simulation" — which is
 * wrong advice in three of the four phases, and visibly wrong now that this
 * sits in the page's largest text.
 *
 * `gridState` arrives only on a live tick and is never hydrated, so a paused
 * run reloaded in a fresh tab legitimately has a tick count and no readings.
 */
function unknownFor(phase: SimulationPhase | undefined): OperatorVerdict {
  const detail =
    phase === "paused"
      ? "The run is paused, so no readings are arriving. Resume to see live grid state."
      : phase === "running"
        ? "Connected, waiting for the first tick to arrive."
        : phase === "finished"
          ? "The run reached the end of the dataset. Reset to start it again."
          : "No readings yet. Start the simulation, or check that the backend is running.";

  return { level: "unknown", headline: "Waiting for telemetry", detail, cause: null };
}

const STABLE: OperatorVerdict = {
  level: "stable",
  headline: "Grid stable",
  detail: "No parameter is over its trip point. Nothing needs pushing.",
  cause: null,
};

/**
 * Ordered most to least urgent, matching the engine's own tie-break. The first
 * match wins, so the headline is always the loudest live condition.
 */
const CONDITIONS: {
  flag: keyof GridState["parameters"];
  level: GridLevel;
  headline: string;
  detail: string;
  cause: string;
}[] = [
  {
    flag: "emergency_triggered",
    level: "contingency",
    headline: "Contingency",
    detail: "The composite emergency score is over the line. This is the highest-priority condition the engine recognises.",
    cause: "the emergency score is above its trip point",
  },
  {
    flag: "freq_deviation_triggered",
    level: "contingency",
    headline: "Frequency unstable",
    detail: "Frequency has left the deadband, which means supply and demand are not matching in real time.",
    cause: "frequency is outside the deadband",
  },
  {
    flag: "spinning_reserve_triggered",
    level: "strained",
    headline: "Reserve margin low",
    detail: "Spare capacity is below the critical threshold. Shedding demand now is what keeps this from becoming an outage.",
    cause: "spinning reserve is below the critical margin",
  },
  {
    flag: "peak_load_triggered",
    level: "strained",
    headline: "Demand over forecast",
    detail: "Load is running above the peak forecast. A shed request here is cheap and buys headroom.",
    cause: "load is above the peak forecast",
  },
  {
    flag: "low_renewable_triggered",
    level: "watch",
    headline: "Renewables low",
    detail: "Little clean generation on the grid. Worth shifting flexible load later rather than cutting it now.",
    cause: "renewable share is below its floor",
  },
  {
    flag: "price_spike_triggered",
    level: "watch",
    headline: "Price spiking",
    detail: "The retail rate is above its spike ratio. Deferring heavy usage is worth the most to households right now.",
    cause: "the retail rate is spiking",
  },
];

/**
 * Summarise the grid for the operator: a level, a headline and the reason.
 *
 * Reads the `*_triggered` booleans the backend stamped on the tick, not the
 * raw values against local thresholds — those flags are overwritten by what
 * `triggers()` actually decided, so this follows a retune immediately.
 */
export function getOperatorVerdict(
  state: GridState | null,
  phase?: SimulationPhase
): OperatorVerdict {
  if (!state?.parameters) return unknownFor(phase);
  const p = state.parameters;

  for (const c of CONDITIONS) {
    if (p[c.flag]) {
      return { level: c.level, headline: c.headline, detail: c.detail, cause: c.cause };
    }
  }
  return STABLE;
}

/**
 * How many parameters are over the line. The headline names one; this says
 * whether it is the only one, which changes how urgent the picture is.
 *
 * Reads the same `*_triggered` booleans the gauges do — and those are
 * overwritten on the outgoing payload by whatever `triggers()` decided this
 * tick, never taken from the CSV, so they follow a live retune.
 */
export function trippedCount(state: GridState | null): number {
  if (!state?.parameters) return 0;
  return CONDITIONS.reduce((n, c) => n + (state.parameters[c.flag] ? 1 : 0), 0);
}
