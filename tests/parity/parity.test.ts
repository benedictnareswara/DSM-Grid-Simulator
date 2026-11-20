/** Parity with the original Python backend. */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Parameter, Severity, Thresholds } from "@/lib/types";
import { type Dataset, loadDataset, SAMPLE_DATASET } from "@/server/grid/dataset";
import * as inc from "@/server/grid/incentives";
import { Simulator } from "@/server/grid/simulator";

const golden = JSON.parse(readFileSync(new URL("./fixtures/python-golden.json", import.meta.url), "utf8"));
const FLAG_KEYS = [
  "peak_load_triggered",
  "freq_deviation_triggered",
  "spinning_reserve_triggered",
  "low_renewable_triggered",
  "emergency_triggered",
  "price_spike_triggered",
] as const;

let dataset: Dataset;
const newSim = () => new Simulator(null as never, null as never, dataset);
const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => rest; // eslint-disable-line @typescript-eslint/no-unused-vars

beforeAll(async () => {
  dataset = await loadDataset(SAMPLE_DATASET);
});

describe("replay parity with the Python engine", () => {
  it("fires the same triggers and alerts on every tick, including after a live retune", () => {
    const sim = newSim();
    const flags: string[] = [];
    const alerts: unknown[] = [];
    for (let tick = 0; tick < dataset.length; tick++) {
      if (tick === golden.retune_at) sim.control.updateThresholds(golden.retune as Partial<Thresholds>);
      const state = sim.gridStateAt(tick);
      flags.push(FLAG_KEYS.map((k) => (state.parameters[k] ? "1" : "0")).join(""));
      alerts.push(...sim.control.evaluate(state).map(withoutId));
    }
    expect(flags.length).toBe(golden.flags.length);
    const firstMismatch = flags.findIndex((f, i) => f !== golden.flags[i]);
    expect(firstMismatch).toBe(-1);
    expect(alerts.length).toBe(golden.alerts.length);
    alerts.forEach((a, i) => expect(a).toEqual(golden.alerts[i]));
  });

  it("composes operator alerts identically", () => {
    const sim = newSim();
    for (const c of golden.composed) {
      const state = sim.gridStateAt(c.tick);
      const override = c.override
        ? {
            durationMinutes: c.override.duration_minutes,
            shedOverride: inc.shedFromSetpoint(c.override.target_reduction_w, c.override.duration_minutes),
          }
        : undefined;
      const alert = sim.control.compose(state, c.parameter as Parameter, c.severity as Severity, override);
      expect(withoutId(alert)).toEqual(c.alert);
    }
  });
});

describe("incentive model parity", () => {
  const g = golden.incentives;
  it("expected shed", () => g.expected_shed.forEach(([p, s, want]: [string, string, number]) => expect(inc.expectedShedKwh(p, s)).toBe(want)));
  it("throttle setpoint", () => g.setpoint.forEach(([k, m, want]: number[]) => expect(inc.throttleSetpoint(k, m)).toBe(want)));
  it("shed from setpoint", () => g.shed_from_setpoint.forEach(([w, m, want]: number[]) => expect(inc.shedFromSetpoint(w, m)).toBe(want)));
  it("response bonus", () =>
    g.bonus.forEach(([l, want, label]: [number | null, number, string | null]) => {
      expect(inc.responseBonus(l)).toBe(want);
      expect(inc.responseBonusLabel(l)).toBe(label);
    }));
  it("streak multiplier", () => g.streak.forEach(([s, want]: number[]) => expect(inc.streakMultiplier(s)).toBe(want)));
  it("credit", () =>
    g.credit.forEach(([r, k, l, s, want]: [number | null, number | null, number | null, number, number]) =>
      expect(inc.creditIdr(r, k, l, s)).toBe(want),
    ));
  it("reliability", () => g.reliability.forEach(([a, m, want]: [number, number | null, number]) => expect(inc.reliability(a, m)).toBe(want)));
});
