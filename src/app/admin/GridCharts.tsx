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
 * Recharts takes colours as props, so it cannot read a CSS custom property — the palette has to be
 * mirrored in JS and swapped by hand when the scheme changes.
 */
const LIGHT = {
  text: "#1f1f21",
  muted: "#6b6b72",
  accent: "#d60c00",
  renew: "#34a853",
  line: "rgba(0,0,0,0.07)",
  limit: "#b45309",
};

const DARK = {
  text: "#f3f3f4",
  muted: "#a6a6ad",
  accent: "#ff6359",
  renew: "#5cd68a",
  line: "rgba(255,255,255,0.09)",
  limit: "#f0a94a",
};

/** The chart palette for the scheme actually being painted. */
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

/** The three views of the run, in one card. */
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

  // Already cumulative and already thinned by the backend (see routes_savings._series).
  const savingsData = (savings?.series ?? []).map((p) => ({
    tick: p.tick,
    kwh: p.kwh,
    credit: p.credit_idr,
  }));

  // Frequency is a narrow band around 50 Hz, so a domain has to be tight to show anything — but a
  // *fixed* one silently clips a real excursion off the top of the chart, which is the one event
  // the view exists for.
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
          // The sliding pill needs to know how many options there are and which is live.
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
          {/* Two Y axes, not one. */}
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
            {/* Where "not enough clean energy" begins, on the axis it belongs to. */}
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
            {/* Both sides of the band. */}
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
          // A flat line at zero and "nobody has accepted anything yet" look identical, and only one
          // of them means the programme is working.
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
