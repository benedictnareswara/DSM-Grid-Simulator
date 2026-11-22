"use client";

import {
  DEFAULT_THRESHOLDS,
  PARAMETER_CONFIGS,
  type GridState,
  type ParameterConfig,
  type SimulationPhase,
  type SimulationStatus,
  type Thresholds,
} from "@/lib/types";
import { RETAIL_MARGIN } from "@/server/grid/constants";
import type { OperatorVerdict } from "./verdict";

const NOMINAL_HZ = 50;
const W = 600;
const H = 150;

const PHASE_LABEL: Record<SimulationPhase, string> = {
  idle: "Ready",
  running: "Running",
  paused: "Paused",
  finished: "Finished",
};

/**
 * The dashboard's opening view: grid frequency traced against its permitted band, like the scope
 * on a control-room wall, with the verdict stated beside it. Excursions past the band draw in red.
 */
export function GridScope({
  history,
  gridState,
  thresholds,
  verdict,
  tripped,
  phase,
  status,
}: {
  history: GridState[];
  gridState: GridState | null;
  thresholds: Thresholds | null;
  verdict: OperatorVerdict;
  tripped: number;
  phase: SimulationPhase;
  status: SimulationStatus | null;
}) {
  const band = (thresholds ?? DEFAULT_THRESHOLDS).freq_deviation_hz;
  const freqs = history.map((s) => s.parameters.frequency_hz);
  const peak = freqs.reduce((m, f) => Math.max(m, Math.abs(f - NOMINAL_HZ)), 0);
  // Room for the band plus any excursion, so the limit lines never sit on the edge.
  const span = Math.max(band * 1.6, peak * 1.15);
  const y = (f: number) => H / 2 - ((f - NOMINAL_HZ) / span) * (H / 2);
  const x = (i: number) => (freqs.length < 2 ? W : (i / (freqs.length - 1)) * W);
  const path = freqs.map((f, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f).toFixed(1)}`).join("");
  const bandTop = y(NOMINAL_HZ + band);
  const bandBottom = y(NOMINAL_HZ - band);
  const latest = freqs.at(-1);

  return (
    <section className={`ds-scope ds-scope--${verdict.level}`} aria-label="Grid status">
      <div className="ds-scope__head">
        <div className="ds-scope__verdict">
          <h2 className="ds-hero__headline">{verdict.headline}</h2>
          <p className="ds-hero__detail">
            {verdict.detail}
            {verdict.cause && ` Because ${verdict.cause}`}
            {verdict.cause && (tripped > 1 ? `, with ${tripped} signals over their limits.` : ".")}
          </p>
        </div>
        <div className="ds-scope__run">
          <span className={`ds-statusline__state ds-statusline__state--${phase}`}>
            {PHASE_LABEL[phase]}
          </span>
          {status ? (
            <>
              <span className="ds-hero__tick">
                Minute {status.current_tick.toLocaleString()}
                <span> of {status.total_ticks.toLocaleString()}</span>
              </span>
              <div
                className="ds-progress ds-progress--slim"
                role="progressbar"
                aria-valuenow={Math.round(status.progress_pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Run progress"
              >
                <div className="ds-progress__fill" style={{ width: `${status.progress_pct}%` }} />
              </div>
              {gridState && <span className="ds-hero__stamp">Replaying {gridState.timestamp}</span>}
            </>
          ) : (
            <span className="ds-hero__stamp">Connecting to the simulator…</span>
          )}
        </div>
      </div>

      <div className="ds-scope__body">
        <div className="ds-scope__readout">
          <span className="ds-scope__reading">{latest != null ? latest.toFixed(2) : "—"}</span>
          <span className="ds-scope__unit">Hz</span>
          <span className="ds-scope__caption">
            Grid frequency, allowed {NOMINAL_HZ} ± {band.toFixed(2)} Hz
          </span>
        </div>

        <div className="ds-scope__screen">
          <svg
            className="ds-scope__svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Frequency over the last ${freqs.length} minutes`}
          >
            <defs>
              {/* Everything outside the permitted band, so the same path re-draws red there. */}
              <clipPath id="ds-scope-outside">
                <rect x="0" y="0" width={W} height={Math.max(bandTop, 0)} />
                <rect x="0" y={bandBottom} width={W} height={Math.max(H - bandBottom, 0)} />
              </clipPath>
            </defs>
            <rect className="ds-scope__band" x="0" y={bandTop} width={W} height={bandBottom - bandTop} />
            <line className="ds-scope__limit" x1="0" x2={W} y1={bandTop} y2={bandTop} />
            <line className="ds-scope__limit" x1="0" x2={W} y1={bandBottom} y2={bandBottom} />
            <line className="ds-scope__nominal" x1="0" x2={W} y1={H / 2} y2={H / 2} />
            {freqs.length > 1 && (
              <>
                <path className="ds-scope__trace" d={path} />
                <path className="ds-scope__trace ds-scope__trace--out" d={path} clipPath="url(#ds-scope-outside)" />
              </>
            )}
          </svg>
          <span className="ds-scope__tag" style={{ top: `${(bandTop / H) * 100}%` }}>
            +{band.toFixed(2)}
          </span>
          <span className="ds-scope__tag" style={{ top: `${(bandBottom / H) * 100}%` }}>
            −{band.toFixed(2)}
          </span>
        </div>
      </div>
    </section>
  );
}

/** How far a signal has travelled toward its limit: 1 is the limit itself. */
function closeness(config: ParameterConfig, state: GridState, t: Thresholds): number {
  const p = state.parameters;
  switch (config.key) {
    case "emergency":
      return p.emergency_score / t.emergency_score;
    case "frequency":
      return Math.abs(p.frequency_hz - NOMINAL_HZ) / t.freq_deviation_hz;
    case "reserve":
      return t.reserve_margin_critical_pct / Math.max(p.reserve_margin_pct, 0.01);
    case "peak_load":
      return p.peak_load_ratio / t.peak_load_ratio;
    case "renewable":
      return t.low_renewable_fraction / Math.max(p.renewable_fraction, 0.001);
    case "price":
      return p.retail_price_idr / (p.tou_base_price_idr * RETAIL_MARGIN) / t.price_spike_ratio;
    default:
      return 0;
  }
}

// The bar runs to 125% of the limit, so the limit mark sits at 80% of its width.
const BAR_MAX = 1.25;

/** The six signals in one strip: each a reading and a bar measured against its own limit. */
export function GaugeRail({
  gridState,
  thresholds,
}: {
  gridState: GridState | null;
  thresholds: Thresholds | null;
}) {
  const t = thresholds ?? DEFAULT_THRESHOLDS;
  return (
    <div className="ds-gauges">
      {PARAMETER_CONFIGS.map((config) => {
        const value = gridState ? (gridState.parameters[config.valueKey] as number) : null;
        const over = gridState ? Boolean(gridState.parameters[config.triggeredKey]) : false;
        const near = gridState ? closeness(config, gridState, t) : 0;
        const fill = Math.min(Math.max(near, 0) / BAR_MAX, 1) * 100;
        const tone = over ? "over" : near >= 0.85 ? "near" : "ok";
        return (
          <div key={config.key} className={`ds-gauge ds-gauge--${tone}`}>
            <span className="ds-gauge__label">{config.label}</span>
            <span className="ds-gauge__value">{value != null ? config.format(value) : "—"}</span>
            <span className="ds-gauge__bar" aria-hidden="true">
              <span className="ds-gauge__fill" style={{ width: `${fill}%` }} />
              <span className="ds-gauge__mark" style={{ left: `${100 / BAR_MAX}%` }} />
            </span>
            <span className="ds-gauge__limit">
              Limit {config.thresholdLabel(t)}
              {over && ", crossed"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
