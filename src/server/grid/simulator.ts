/**
 * The simulator replays the dataset one row per tick. Each tick it builds the
 * grid state, runs the control logic, records any alert, autopushes it if that
 * is on, and broadcasts.
 */

import type { DSMAlert, GridState, SimulationPhase, SimulationStatus } from "@/lib/types";
import type { DB } from "../db/client";
import type { Hub } from "../realtime/hub";
import { markPushed, recordTrigger } from "../alerts/store";
import {
  AUTOPUSH_DEFAULT_ENABLED,
  AUTOPUSH_MIN_SEVERITY,
  DEFAULT_TICK_INTERVAL_MS,
  MAX_TICK_INTERVAL_MS,
  MIN_TICK_INTERVAL_MS,
  SEVERITY_PRIORITY,
} from "./constants";
import { ControlLogic } from "./control-logic";
import type { Dataset } from "./dataset";
import { pyRound } from "./pyround";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Simulator {
  readonly control = new ControlLogic();
  currentTick = 0;
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
  running = false;
  paused = false;
  autopushEnabled = AUTOPUSH_DEFAULT_ENABLED;
  // Bumped on every stop, so a loop that is mid-sleep can tell it has been superseded.
  private generation = 0;

  constructor(
    private readonly hub: Hub,
    private readonly db: DB,
    readonly dataset: Dataset,
  ) {}

  get totalTicks(): number {
    return this.dataset.length;
  }

  /**
   * The one run-state value the dashboards render from. `finished` is real:
   * the tick is parked past the end, so the UI offers Restart instead of Start.
   */
  get phase(): SimulationPhase {
    if (this.totalTicks > 0 && this.currentTick >= this.totalTicks) return "finished";
    if (this.running) return this.paused ? "paused" : "running";
    return "idle";
  }

  getStatus(): SimulationStatus {
    return {
      running: this.running,
      paused: this.paused,
      phase: this.phase,
      current_tick: this.currentTick,
      total_ticks: this.totalTicks,
      tick_interval_ms: this.tickIntervalMs,
      progress_pct: pyRound((this.currentTick / Math.max(this.totalTicks, 1)) * 100, 2),
      current_timestamp: this.currentTick < this.totalTicks ? this.dataset.timestamp(this.currentTick) : undefined,
    };
  }

  /**
   * The grid at the parked tick, whatever the run state. This is what lets an
   * operator compose a test alert before starting. Clamped to the last row
   * once finished.
   */
  currentGridState(): GridState | null {
    if (this.totalTicks === 0) return null;
    return this.gridStateAt(Math.min(this.currentTick, this.totalTicks - 1));
  }

  setSpeed(intervalMs: number): void {
    this.tickIntervalMs = Math.max(MIN_TICK_INTERVAL_MS, Math.min(MAX_TICK_INTERVAL_MS, intervalMs));
    console.log(`[Simulator] Speed set to ${this.tickIntervalMs}ms per tick`);
  }

  setAutopush(enabled: boolean): void {
    this.autopushEnabled = enabled;
    console.log(`[Simulator] Autopush ${enabled ? "enabled" : "disabled"} (min severity: ${AUTOPUSH_MIN_SEVERITY})`);
  }

  start(): void {
    this.running = true;
    this.paused = false;
    console.log(`[Simulator] Starting from tick ${this.currentTick}`);
    void this.runLoop(++this.generation);
  }

  pause(): string {
    if (!this.running) return "Nothing running to pause";
    if (this.paused) return "Already paused";
    this.paused = true;
    console.log(`[Simulator] Paused at tick ${this.currentTick}`);
    return "Simulation paused";
  }

  resume(): string {
    if (!this.running) return "Nothing running to resume";
    if (!this.paused) return "Already running";
    this.paused = false;
    console.log(`[Simulator] Resumed from tick ${this.currentTick}`);
    return "Simulation resumed";
  }

  /** Clears `paused` too, so a stop-while-paused doesn't leave a stale flag in the status. */
  stop(): void {
    this.running = false;
    this.paused = false;
    this.generation++;
    console.log(`[Simulator] Stopped at tick ${this.currentTick}`);
  }

  /** Back to tick 0 with fresh cooldowns. Clients empty their feeds on the `system_reset` broadcast. */
  reset(): void {
    this.stop();
    this.currentTick = 0;
    this.control.resetCooldowns();
    console.log("[Simulator] Reset to tick 0");
  }

  /**
   * Build the grid state for one row. The six `*_triggered` flags come from
   * the control logic, never from the dataset, so gauges, alerts and the
   * consumer verdict all agree with the live thresholds.
   */
  gridStateAt(tick: number): GridState {
    const r = this.dataset.row(tick);
    const parameters = {
      load_forecast_ema: r.load_forecast_ema,
      peak_load_ratio: r.peak_load_ratio,
      peak_load_triggered: false,
      frequency_hz: r.frequency_hz,
      freq_deviation_hz: r.freq_deviation_hz,
      freq_deviation_triggered: false,
      neighborhood_demand_kw: r.neighborhood_demand_kw,
      reserve_margin_pct: r.reserve_margin_pct,
      spinning_reserve_triggered: false,
      solar_output_kw: r.solar_output_kw,
      wind_output_kw: r.wind_output_kw,
      renewable_fraction: r.renewable_fraction,
      low_renewable_triggered: false,
      voltage_deviation_pct: r.voltage_deviation_pct,
      apparent_power_kva: r.apparent_power_kva,
      emergency_score: r.emergency_score,
      emergency_triggered: false,
      tou_base_price_idr: r.tou_base_price_idr,
      wholesale_price_idr: r.wholesale_price_idr,
      retail_price_idr: r.retail_price_idr,
      price_spike_triggered: false,
    };
    Object.assign(parameters, this.control.triggers(parameters));
    return {
      tick,
      timestamp: this.dataset.timestamp(tick),
      sim_time: new Date().toISOString(),
      measurements: {
        global_active_power: r.Global_active_power,
        global_reactive_power: r.Global_reactive_power,
        voltage: r.Voltage,
        global_intensity: r.Global_intensity,
        sub_metering_1: r.Sub_metering_1,
        sub_metering_2: r.Sub_metering_2,
        sub_metering_3: r.Sub_metering_3,
      },
      parameters,
    };
  }

  private qualifiesForAutopush(alert: DSMAlert): boolean {
    return (SEVERITY_PRIORITY[alert.severity] ?? 0) >= SEVERITY_PRIORITY[AUTOPUSH_MIN_SEVERITY];
  }

  /**
   * Relay qualifying alerts through the same entry point as a manual push.
   * Autopush removes the click, not the gateway gate: with no gateway the alert
   * is dropped and marked "esp32_offline".
   */
  private autopush(alerts: DSMAlert[]): void {
    for (const alert of alerts) {
      if (!this.qualifiesForAutopush(alert)) continue;
      alert.auto_push_status = this.hub.gatewayConnected ? "sent" : "esp32_offline";
      markPushed(this.db, alert, null, true);
      this.hub.relayAlertToGateway(alert);
      console.log(`[Simulator] Autopush [${alert.severity}] ${alert.title} -> ${alert.auto_push_status}`);
    }
  }

  /** One tick of work. Exposed so tests can step the engine without timers. */
  step(): DSMAlert[] {
    const state = this.gridStateAt(this.currentTick);
    const alerts = this.control.evaluate(state);
    // Persist before anyone decides anything, so the admin feed survives a reload.
    // It isn't a delivery path: households only see rows with delivered_at set.
    for (const alert of alerts) recordTrigger(this.db, alert);
    if (this.autopushEnabled && alerts.length) this.autopush(alerts);
    this.hub.broadcastTick(state, alerts);
    this.currentTick++;
    return alerts;
  }

  private async runLoop(gen: number): Promise<void> {
    const live = () => this.running && gen === this.generation;
    try {
      while (live() && this.currentTick < this.totalTicks) {
        while (this.paused && live()) await sleep(100);
        if (!live()) return;
        this.step();
        await sleep(this.tickIntervalMs);
      }
      if (gen !== this.generation) return;
      this.running = false;
      console.log(`[Simulator] Simulation complete at tick ${this.currentTick}`);
      this.hub.broadcastStatus(this.getStatus());
    } catch (err) {
      console.error("[Simulator] Error:", err);
      this.running = false;
    }
  }
}
