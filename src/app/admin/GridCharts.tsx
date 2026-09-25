"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Area,
  AreaChart,
  Legend,
  ReferenceLine,
  Label,
} from "recharts";
import { DEFAULT_THRESHOLDS, type GridState, type SavingsSummary, type Thresholds } from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";

/**
 * Recharts takes colours as props, so it cannot read a CSS custom property —
 * the palette has to be mirrored in JS and swapped by hand when the scheme
 * changes. Keep these in step with `:root` and its dark block in globals.css.
 */
const LIGHT = {
  text: "#1d1d1f",
  muted: "#6e6e73",
  accent: "#0071e3",
  renew: "#34a853",
  line: "rgba(0,0,0,0.07)",
  limit: "#b45309",
};

const DARK = {
  text: "#f5f5f7",
  muted: "#a1a1a6",
  accent: "#0a84ff",
  renew: "#5cd68a",
  line: "rgba(255,255,255,0.09)",
  limit: "#f0a94a",
};

/**
 * The chart palette for the scheme actually being painted.
 *
 * This reads `useTheme()` rather than `matchMedia` directly, and that is
 * load-bearing: the operator can override the OS scheme from the sidebar, so
 * `prefers-color-scheme` is no longer the source of truth. Subscribing to it
 * here would leave the charts drawing the light palette on a manually
 * darkened page — and only for someone who *used* the override, so it would
 * pass every test done by flipping the OS.
 *
 * Everything else on the page recolours through CSS custom properties. Only
 * Recharts needs this, because it takes colours as props.
 */
function useChartColors() {
  const { resolved } = useTheme();
  return resolved === "dark" ? DARK : LIGHT;
}

type ChartView = "demand" | "frequency" | "savings";

const VIEWS: { id: ChartView; label: string; title: string }[] = [
  { id: "demand", label: "Demand", title: "Demand vs renewable generation" },
  { id: "frequency", label: "Freq / price", title: "Frequency & retail price" },
  { id: "savings", label: "Saved", title: "Cumulative energy shifted" },
];

/**
 * The three views of the run, in one card.
 *
 * Segmented rather than stacked because only one is ever being read, and three
 * permanent charts is three-quarters of the viewport spent on the two nobody is
 * looking at.
 *
 * ## One clock
 *
 * Every series here is plotted against the **simulated** clock — the tick, and
 * the dataset timestamp that belongs to it. That is worth stating because the
 * savings view used to be plotted against `responded_at`, the *real* wall-clock
 * instant a household tapped Accept. Two charts one click apart therefore had
 * two different meanings for the same horizontal position, and on a UTC+7 host
 * the third was also seven hours off, because `responded_at` is stored as UTC
 * and was being sliced as a string. `SavingsPoint` has always carried `tick`;
 * it simply was not being used.
 *
 * ## The trip lines
 *
 * Each chart draws a `ReferenceLine` at the threshold the engine is actually
 * using. A trace with no line on it says how the grid is behaving but not
 * whether that is a problem, which is most of why these read as decorative.
 */
export function GridCharts({
  history,
  savings,
  thresholds,
}: {
  history: GridState[];
  savings: SavingsSummary | null;
  /** Live, for the trip lines. Falls back to the compiled-in defaults. */
  thresholds: Thresholds | null;
}) {
  const [view, setView] = useState<ChartView>("demand");
  const c = useChartColors();
  const t = thresholds ?? DEFAULT_THRESHOLDS;

  const axisTick = { fill: c.muted, fontSize: 11 };
  const legendStyle = { fontSize: 11, color: c.muted };

  const chartData = history.map((s: GridState, i: number) => ({
    idx: i,
    time: s.timestamp?.slice(11, 16) || "",
    frequency: s.parameters.frequency_hz,
    price: s.parameters.retail_price_idr,
    demand: s.parameters.neighborhood_demand_kw,
    renewable: s.parameters.renewable_fraction * 100,
  }));

  // Already cumulative and already thinned by the backend (see
  // routes_savings._series). Labelled by the *alert's* tick, not by when the
  // answer happened to arrive — see the module note above.
  const savingsData = (savings?.series ?? []).map((p) => ({
    tick: p.tick,
    kwh: p.kwh,
    credit: p.credit_idr,
  }));

  // Frequency is a narrow band around 50 Hz, so a domain has to be tight to
  // show anything — but a *fixed* one silently clips a real excursion off the
  // top of the chart, which is the one event the view exists for. Derived from
  // the data with the trip band as a floor, so the lines are always visible and
  // an outlier widens the axis instead of vanishing.
  const freqValues = chartData.map((d) => d.frequency).filter((v) => Number.isFinite(v));
  const freqPad = Math.max(t.freq_deviation_hz * 1.4, 0.25);
  const freqDomain: [number, number] = [
    Math.min(50 - freqPad, ...freqValues) - 0.05,
    Math.max(50 + freqPad, ...freqValues) + 0.05,
  ];

  const selected = VIEWS.findIndex((v) => v.id === view);

  return (
    <div className="ds-card ds-chart">
      <div className="ds-title">
        {VIEWS.find((v) => v.id === view)?.title}
        <span
          className="ds-segment"
          // The sliding pill needs to know how many options there are and
          // which is live. A dynamic value has nowhere to go but inline.
          style={{ "--n": VIEWS.length, "--i": selected } as React.CSSProperties}
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className="ds-segment__btn"
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </span>
      </div>

      {view === "demand" && (
        <ResponsiveContainer width="100%" height={240}>
          {/* Two Y axes, not one. These series are kW and percent — on a shared
              axis the renewable trace was pinned flat against the floor of a
              scale running to hundreds of kW, which read as "no renewables"
              rather than "different unit". Both axes are now labelled, because
              the legend's colours were the only thing saying which was which. */}
          <AreaChart data={chartData} margin={{ top: 18, right: 8, bottom: 0, left: -4 }}>
            <defs>
              <linearGradient id="demandGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={c.accent} stopOpacity={0.22} />
                <stop offset="95%" stopColor={c.accent} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="renewGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={c.renew} stopOpacity={0.24} />
                <stop offset="95%" stopColor={c.renew} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={c.line} vertical={false} />
            <XAxis dataKey="time" tick={axisTick} stroke={c.line} tickLine={false} />
            <YAxis
              yAxisId="kw"
              tick={axisTick}
              stroke={c.line}
              tickLine={false}
              width={48}
              label={{ value: "kW", position: "top", offset: 12, fill: c.muted, fontSize: 10 }}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              domain={[0, 100]}
              unit="%"
              tick={axisTick}
              stroke={c.line}
              tickLine={false}
              width={44}
              label={{ value: "%", position: "top", offset: 12, fill: c.muted, fontSize: 10 }}
            />
            <Tooltip wrapperClassName="ds-tooltip" cursor={{ stroke: c.muted, strokeWidth: 1 }} />
            <Legend wrapperStyle={legendStyle} iconType="plainline" iconSize={14} />
            {/* Where "not enough clean energy" begins, on the axis it belongs
                to. Without it the renewable trace is a shape with no verdict. */}
            <ReferenceLine
              yAxisId="pct"
              y={t.low_renewable_fraction * 100}
              stroke={c.limit}
              strokeDasharray="4 4"
              strokeWidth={1}
            >
              <Label
                value={`renewable floor ${(t.low_renewable_fraction * 100).toFixed(0)}%`}
                position="insideBottomRight"
                fill={c.limit}
                fontSize={10}
              />
            </ReferenceLine>
            <Area
              yAxisId="kw"
              type="monotone"
              dataKey="demand"
              stroke={c.accent}
              fill="url(#demandGrad)"
              name="Demand (kW)"
              strokeWidth={2}
            />
            <Area
              yAxisId="pct"
              type="monotone"
              dataKey="renewable"
              stroke={c.renew}
              fill="url(#renewGrad)"
              name="Renewable (%)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}

      {view === "frequency" && (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top: 18, right: 8, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={c.line} vertical={false} />
            <XAxis dataKey="time" tick={axisTick} stroke={c.line} tickLine={false} />
            <YAxis
              yAxisId="freq"
              domain={freqDomain}
              tickFormatter={(v: number) => v.toFixed(2)}
              tick={axisTick}
              stroke={c.line}
              tickLine={false}
              width={48}
              label={{ value: "Hz", position: "top", offset: 12, fill: c.muted, fontSize: 10 }}
            />
            <YAxis
              yAxisId="price"
              orientation="right"
              tick={axisTick}
              stroke={c.line}
              tickLine={false}
              width={52}
              label={{ value: "Rp", position: "top", offset: 12, fill: c.muted, fontSize: 10 }}
            />
            <Tooltip wrapperClassName="ds-tooltip" cursor={{ stroke: c.muted, strokeWidth: 1 }} />
            <Legend wrapperStyle={legendStyle} iconType="plainline" iconSize={14} />
            {/* Both sides of the band. Frequency deviation is symmetric — the
                gate fires on |50 − f|, so one line would describe half of it. */}
            <ReferenceLine
              yAxisId="freq"
              y={50 + t.freq_deviation_hz}
              stroke={c.limit}
              strokeDasharray="4 4"
              strokeWidth={1}
            >
              <Label
                value={`±${t.freq_deviation_hz} Hz`}
                position="insideTopRight"
                fill={c.limit}
                fontSize={10}
              />
            </ReferenceLine>
            <ReferenceLine
              yAxisId="freq"
              y={50 - t.freq_deviation_hz}
              stroke={c.limit}
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <Line
              yAxisId="freq"
              type="monotone"
              dataKey="frequency"
              stroke={c.accent}
              dot={false}
              name="Frequency (Hz)"
              strokeWidth={2}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="price"
              stroke={c.renew}
              dot={false}
              name="Retail price (Rp/kWh)"
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {view === "savings" &&
        (savingsData.length === 0 ? (
          // A flat line at zero and "nobody has accepted anything yet" look
          // identical, and only one of them means the programme is working.
          <div className="ds-empty">
            <strong>Nothing shifted yet</strong>
            This fills in as households accept the alerts you push.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={savingsData} margin={{ top: 18, right: 8, bottom: 0, left: -4 }}>
              <defs>
                <linearGradient id="savedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={c.accent} stopOpacity={0.26} />
                  <stop offset="95%" stopColor={c.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={c.line} vertical={false} />
              {/* The simulated clock, same as the other two views. */}
              <XAxis
                dataKey="tick"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => `t${v.toLocaleString()}`}
                tick={axisTick}
                stroke={c.line}
                tickLine={false}
              />
              <YAxis
                tick={axisTick}
                stroke={c.line}
                tickLine={false}
                width={48}
                label={{ value: "kWh", position: "top", offset: 12, fill: c.muted, fontSize: 10 }}
              />
              <Tooltip
                wrapperClassName="ds-tooltip"
                cursor={{ stroke: c.muted, strokeWidth: 1 }}
                labelFormatter={(v) => `tick ${Number(v).toLocaleString()}`}
              />
              {/* No legend: one series, already named by the card title. */}
              <Area
                type="monotone"
                dataKey="kwh"
                stroke={c.accent}
                fill="url(#savedGrad)"
                name="kWh shifted"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        ))}
    </div>
  );
}
