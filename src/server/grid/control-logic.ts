/**
 * The control logic: checks all six grid parameters on every tick and emits
 * DSM alerts.
 *
 * - The thresholds are live. Every gate compares a raw value from the dataset
 *   against `this.thresholds`, which POST /api/thresholds changes.
 * - Each parameter has a cooldown sized by severity, so it doesn't re-fire
 *   every minute.
 * - At most one alert per tick: when several parameters fire together, the
 *   highest severity wins, then the higher PARAMETER_META priority.
 */

import { randomUUID } from "node:crypto";
import type { DSMAlert, GridParameters, GridState, Parameter, Severity, Thresholds } from "@/lib/types";
import {
  ALERT_COOLDOWN_TICKS,
  COOLDOWN_TICKS_BY_SEVERITY,
  PARAMETER_META,
  RETAIL_MARGIN,
  SEVERITY_ESCALATION,
  SEVERITY_PRIORITY,
  THRESHOLDS,
  type ThresholdKey,
} from "./constants";
import { expectedShedKwh, throttleSetpoint, throttleWindowMinutes } from "./incentives";
import { pyFixed, pyGrouped, pyRound, pySigned } from "./pyround";

export type TriggerFlag =
  | "peak_load_triggered"
  | "freq_deviation_triggered"
  | "spinning_reserve_triggered"
  | "low_renewable_triggered"
  | "emergency_triggered"
  | "price_spike_triggered";

/** Only POST /api/alert/test passes these: an operator-chosen window and/or shed. */
export interface ThrottleOverride {
  durationMinutes?: number;
  shedOverride?: number;
}

type AlertFields = Pick<
  DSMAlert,
  "severity" | "parameter" | "title" | "message" | "incentive" | "reward_idr_per_kwh" | "value" | "threshold"
>;

const reward = (parameter: Parameter): number => PARAMETER_META[parameter].reward_idr_per_kwh as number;

export class ControlLogic {
  thresholds: Thresholds = { ...THRESHOLDS };
  private cooldownUntil = new Map<string, number>();

  updateThresholds(updates: Partial<Thresholds>): void {
    for (const [key, value] of Object.entries(updates)) {
      if (key in this.thresholds && value != null) {
        this.thresholds[key as ThresholdKey] = value;
      }
    }
  }

  resetCooldowns(): void {
    this.cooldownUntil.clear();
  }

  // ── The six gates ──────────────────────────────────────────────────────────

  /** What retail would cost right now if nothing were wrong. The P6 gate is relative to this. */
  normalRetailPrice(p: GridParameters): number {
    return p.tou_base_price_idr * RETAIL_MARGIN;
  }

  priceSpikeThreshold(p: GridParameters): number {
    return this.normalRetailPrice(p) * this.thresholds.price_spike_ratio;
  }

  /**
   * The single answer to "is this parameter over the line". Alerts, the
   * dashboard gauges and the consumer verdict all read it, so they can't disagree.
   */
  triggers(p: GridParameters): Record<TriggerFlag, boolean> {
    const t = this.thresholds;
    return {
      peak_load_triggered: p.peak_load_ratio > t.peak_load_ratio,
      freq_deviation_triggered: Math.abs(p.freq_deviation_hz) > t.freq_deviation_hz,
      spinning_reserve_triggered: p.reserve_margin_pct < t.reserve_margin_critical_pct,
      low_renewable_triggered: p.renewable_fraction < t.low_renewable_fraction,
      emergency_triggered: p.emergency_score > t.emergency_score,
      price_spike_triggered: p.retail_price_idr > this.priceSpikeThreshold(p),
    };
  }

  // ── Building alerts ────────────────────────────────────────────────────────

  /**
   * Fill in what every alert shares: the energy ask (`expected_shed_kwh`) and
   * the same ask as a setpoint (`target_reduction_w` watts for
   * `duration_minutes`). The load controller acts on the setpoint.
   */
  private alert(state: GridState, fields: AlertFields, override: ThrottleOverride = {}): DSMAlert {
    const window = override.durationMinutes || throttleWindowMinutes(fields.severity);
    const shed = override.shedOverride ?? expectedShedKwh(fields.parameter, fields.severity);
    return {
      id: randomUUID().slice(0, 8),
      tick: state.tick,
      timestamp: state.timestamp,
      ...fields,
      expected_shed_kwh: shed,
      duration_minutes: window,
      target_reduction_w: throttleSetpoint(shed, window),
      auto_push_status: null,
    };
  }

  /**
   * Name what's driving the emergency composite. Only voltage and demand are
   * on the wire (the ramp term stays in the pipeline), so name the bigger of
   * those two, each scaled by its own alarm point, or say that neither dominates.
   */
  private emergencyLead(p: GridParameters): string {
    const voltageRatio = Math.abs(p.voltage_deviation_pct) / 5.0;
    const demandRatio = p.peak_load_ratio / Math.max(this.thresholds.peak_load_ratio, 0.01);

    if (voltageRatio < 1.0 && demandRatio < 1.0) {
      return "Grid contingency: several conditions are stressed at once, none of them dominant.";
    }
    if (voltageRatio >= demandRatio) {
      const direction = p.voltage_deviation_pct < 0 ? "under" : "over";
      return (
        `Grid contingency, led by voltage: running ${direction} nominal ` +
        `by ${pyFixed(Math.abs(p.voltage_deviation_pct), 1)}%.`
      );
    }
    return `Grid contingency, led by demand: load is ${pyFixed(p.peak_load_ratio, 1)}× forecast.`;
  }

  // Each parameter has a severity function (how bad is this reading) and a
  // candidate function (what the alert says). compose() calls a candidate with
  // an operator-chosen severity, so composed alerts carry the real wording.

  severityFor(parameter: Parameter, p: GridParameters): Severity {
    switch (parameter) {
      case "peak_load":
        return p.peak_load_ratio > SEVERITY_ESCALATION.peak_load ? "critical" : "warning";
      case "frequency":
        return Math.abs(p.freq_deviation_hz) > SEVERITY_ESCALATION.frequency ? "emergency" : "critical";
      case "reserve_margin":
        return p.reserve_margin_pct < SEVERITY_ESCALATION.reserve_margin ? "emergency" : "critical";
      case "renewable":
        // The only gate that can emit `info`. Renewables drop to zero every
        // night; that's only worth acting on when demand is also up.
        return p.peak_load_ratio > 1.0 ? "warning" : "info";
      case "emergency":
        return p.emergency_score > SEVERITY_ESCALATION.emergency ? "emergency" : "critical";
      case "price":
        // A tariff signal, not a physical state: it never escalates.
        return "warning";
    }
  }

  private candidate(parameter: Parameter, state: GridState, severity: Severity, override?: ThrottleOverride): DSMAlert {
    const p = state.parameters;
    const t = this.thresholds;
    switch (parameter) {
      case "peak_load": {
        const r = reward("peak_load");
        return this.alert(
          state,
          {
            severity,
            parameter,
            title: "⚡ Peak Demand Alert",
            message:
              `Load is ${pyFixed(p.peak_load_ratio, 1)}× above forecast. ` +
              `Current neighborhood demand: ${pyFixed(p.neighborhood_demand_kw, 0)} kW.`,
            incentive:
              `Shift heavy appliances (AC, washing machine) to off-peak hours. ` +
              `Earn Rp ${pyGrouped(r, 0)}/kWh credit for reducing consumption now!`,
            reward_idr_per_kwh: r,
            value: p.peak_load_ratio,
            threshold: t.peak_load_ratio,
          },
          override,
        );
      }
      case "frequency": {
        const r = reward("frequency");
        const direction = p.freq_deviation_hz < 0 ? "dropping" : "rising";
        return this.alert(
          state,
          {
            severity,
            parameter,
            title: "🔄 Frequency Instability",
            message:
              `Grid frequency ${direction} to ${pyFixed(p.frequency_hz, 3)} Hz ` +
              `(deviation: ${pySigned(p.freq_deviation_hz, 3)} Hz). ` +
              `Supply-demand imbalance detected.`,
            incentive:
              `Grid stability at risk. Please reduce non-essential loads immediately. ` +
              `Emergency demand response credit: Rp ${pyGrouped(r, 0)}/kWh.`,
            reward_idr_per_kwh: r,
            value: Math.abs(p.freq_deviation_hz),
            threshold: t.freq_deviation_hz,
          },
          override,
        );
      }
      case "reserve_margin": {
        const r = reward("reserve_margin");
        return this.alert(
          state,
          {
            severity,
            parameter,
            title: "🔋 Low Spinning Reserve",
            message:
              `Reserve margin at ${pyFixed(p.reserve_margin_pct, 1)}% — ` +
              `critically low. Grid nearing capacity.`,
            incentive:
              `Grid capacity nearly exhausted. Reduce consumption to avoid blackout. ` +
              `Emergency bonus: Rp ${pyGrouped(r, 0)}/kWh saved!`,
            reward_idr_per_kwh: r,
            value: p.reserve_margin_pct,
            threshold: t.reserve_margin_critical_pct,
          },
          override,
        );
      }
      case "renewable": {
        const r = reward("renewable");
        // Worded from the grid, not from `severity`: an operator forcing a
        // severity hasn't changed what is actually happening.
        const demandElevated = p.peak_load_ratio > 1.0;
        return this.alert(
          state,
          {
            severity,
            parameter,
            title: "🌤️ Low Renewable Generation",
            message:
              `Renewable energy at ${pyFixed(p.renewable_fraction * 100, 1)}% of capacity ` +
              `(Solar: ${pyFixed(p.solar_output_kw, 0)} kW, Wind: ${pyFixed(p.wind_output_kw, 0)} kW). ` +
              (demandElevated
                ? `Demand is ${pyFixed(p.peak_load_ratio, 1)}× forecast, so the ` +
                  `shortfall is being covered by fossil generation.`
                : "Demand is low, so this is background information " + "rather than something to act on now."),
            incentive:
              `Low clean energy right now. Best time to use power: 10 AM – 2 PM ` +
              `when solar peaks. Shift loads to save Rp ${pyGrouped(r, 0)}/kWh!`,
            reward_idr_per_kwh: r,
            value: p.renewable_fraction,
            threshold: t.low_renewable_fraction,
          },
          override,
        );
      }
      case "emergency": {
        const r = reward("emergency");
        return this.alert(
          state,
          {
            severity,
            parameter,
            title: "🚨 Grid Emergency",
            // Lead with the contributor we can name; the composite score alone
            // tells a household nothing they can act on.
            message:
              `${this.emergencyLead(p)} ` +
              `Composite score ${pyFixed(p.emergency_score, 2)} ` +
              `(voltage ${pySigned(p.voltage_deviation_pct, 1)}%, ` +
              `demand ${pyFixed(p.peak_load_ratio, 1)}× forecast, ` +
              `${pyFixed(p.apparent_power_kva, 2)} kVA).`,
            incentive:
              `URGENT: Grid contingency event! Immediately reduce all ` +
              `non-critical loads. Emergency credit: Rp ${pyGrouped(r, 0)}/kWh.`,
            reward_idr_per_kwh: r,
            value: p.emergency_score,
            threshold: t.emergency_score,
          },
          override,
        );
      }
      case "price": {
        // Reward and baseline are measured against normal retail for this hour.
        const normalRetail = this.normalRetailPrice(p);
        return this.alert(
          state,
          {
            severity,
            parameter,
            title: "💰 Price Spike Alert",
            message:
              `Electricity price surged to Rp ${pyGrouped(p.retail_price_idr, 0)}/kWh ` +
              `(wholesale: Rp ${pyGrouped(p.wholesale_price_idr, 0)}/kWh). ` +
              `Dynamic pricing in effect.`,
            incentive:
              `Price is elevated! Defer heavy usage to save. ` +
              `Current rate: Rp ${pyGrouped(p.retail_price_idr, 0)}/kWh vs ` +
              `Rp ${pyGrouped(normalRetail, 0)}/kWh normal for this hour.`,
            // Deferring 1 kWh saves exactly how far the price sits above normal.
            reward_idr_per_kwh: Math.max(pyRound(p.retail_price_idr - normalRetail), 0),
            value: p.retail_price_idr,
            threshold: pyRound(this.priceSpikeThreshold(p), 2),
          },
          override,
        );
      }
    }
  }

  // P1→P6 order. This is only the fallback for a full tie; it isn't the priority order.
  static readonly GATES: ReadonlyArray<readonly [Parameter, TriggerFlag]> = [
    ["peak_load", "peak_load_triggered"],
    ["frequency", "freq_deviation_triggered"],
    ["reserve_margin", "spinning_reserve_triggered"],
    ["renewable", "low_renewable_triggered"],
    ["emergency", "emergency_triggered"],
    ["price", "price_spike_triggered"],
  ];

  /**
   * Build one alert for a parameter without asking its gate, for
   * POST /api/alert/test. It never reads or starts a cooldown: composing an
   * alert isn't the same as triggering one.
   */
  compose(state: GridState, parameter: Parameter, severity: Severity, override: ThrottleOverride = {}): DSMAlert {
    return this.candidate(parameter, state, severity, override);
  }

  buildCandidates(state: GridState): DSMAlert[] {
    const p = state.parameters;
    const fired = this.triggers(p);
    const out: DSMAlert[] = [];
    for (const [parameter, flag] of ControlLogic.GATES) {
      if (fired[flag]) out.push(this.candidate(parameter, state, this.severityFor(parameter, p)));
    }
    return out;
  }

  // ── Cooldown and prioritisation ────────────────────────────────────────────

  private isOnCooldown(parameter: string, tick: number): boolean {
    return tick < (this.cooldownUntil.get(parameter) ?? -1);
  }

  cooldownTicksFor(severity: string): number {
    return COOLDOWN_TICKS_BY_SEVERITY[severity as Severity] ?? ALERT_COOLDOWN_TICKS;
  }

  /** Severity first, then parameter priority. A full tie keeps the first (P1→P6 order). */
  private prioritize(alerts: DSMAlert[]): DSMAlert | null {
    let best: DSMAlert | null = null;
    let bestKey: [number, number] = [-Infinity, -Infinity];
    for (const a of alerts) {
      const key: [number, number] = [
        SEVERITY_PRIORITY[a.severity] ?? 0,
        PARAMETER_META[a.parameter as Parameter]?.priority ?? 0,
      ];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = a;
        bestKey = key;
      }
    }
    return best;
  }

  /** At most one alert per tick: the highest-priority candidate not on cooldown. */
  evaluate(state: GridState): DSMAlert[] {
    const eligible = this.buildCandidates(state).filter((a) => !this.isOnCooldown(a.parameter, state.tick));
    const winner = this.prioritize(eligible);
    if (!winner) return [];
    this.cooldownUntil.set(winner.parameter, state.tick + this.cooldownTicksFor(winner.severity));
    return [winner];
  }
}
