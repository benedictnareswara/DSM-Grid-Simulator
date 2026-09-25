/**
 * The replay dataset: the transformed household-power CSV (optionally gzipped),
 * loaded into typed arrays, one per column.
 *
 * Values are held as float32, the same precision the original backend used.
 * These are simulated values with 3–4 significant figures, and float32 halves
 * the memory of the full 2-million-row replay. Timestamps are held as epoch
 * milliseconds and formatted back into the dataset's own "YYYY-MM-DD HH:MM:SS"
 * form.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { resolveFromRoot } from "../env";

// Exactly the columns the simulator reads. The dataset's baked `*_triggered`
// columns are skipped on purpose: the control logic evaluates them live against
// the current thresholds.
export const VALUE_COLUMNS = [
  "Global_active_power",
  "Global_reactive_power",
  "Voltage",
  "Global_intensity",
  "Sub_metering_1",
  "Sub_metering_2",
  "Sub_metering_3",
  "load_forecast_ema",
  "peak_load_ratio",
  "frequency_hz",
  "freq_deviation_hz",
  "neighborhood_demand_kw",
  "reserve_margin_pct",
  "solar_output_kw",
  "wind_output_kw",
  "renewable_fraction",
  "voltage_deviation_pct",
  "apparent_power_kva",
  "emergency_score",
  "tou_base_price_idr",
  "wholesale_price_idr",
  "retail_price_idr",
] as const;

export type ValueColumn = (typeof VALUE_COLUMNS)[number];
export type Row = Record<ValueColumn, number>;

export const SAMPLE_DATASET = "data/sample.csv.gz";
export const FULL_DATASET = "data/full.csv.gz";

export class Dataset {
  constructor(
    readonly length: number,
    private readonly times: Float64Array,
    private readonly columns: Record<ValueColumn, Float32Array>,
    readonly source: string,
  ) {}

  /** The dataset's own timestamp string for row `i`, e.g. "2006-12-16 17:24:00". */
  timestamp(i: number): string {
    return new Date(this.times[i]).toISOString().slice(0, 19).replace("T", " ");
  }

  row(i: number): Row {
    const out = {} as Row;
    for (const c of VALUE_COLUMNS) out[c] = this.columns[c][i];
    return out;
  }
}

/** Which file DATASET names. "full" falls back to the sample when it hasn't been downloaded. */
export function resolveDatasetPath(setting: string): string {
  if (setting === "sample") return resolveFromRoot(SAMPLE_DATASET);
  if (setting === "full") {
    const full = resolveFromRoot(FULL_DATASET);
    if (existsSync(full)) return full;
    console.warn("[Dataset] DATASET=full but data/full.csv.gz is missing — run `npm run data:full`. Using the sample.");
    return resolveFromRoot(SAMPLE_DATASET);
  }
  return resolveFromRoot(setting);
}

/** Parse "YYYY-MM-DD HH:MM:SS" as a naive (zone-less) time, stored as if UTC. */
function parseNaive(s: string): number {
  return Date.parse(`${s.trim().replace(" ", "T")}Z`);
}

export async function loadDataset(file: string): Promise<Dataset> {
  if (!existsSync(file)) {
    throw new Error(`Dataset not found: ${file}`);
  }
  const started = Date.now();
  const raw = createReadStream(file);
  const input = file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const lines = createInterface({ input, crlfDelay: Infinity });

  let capacity = 1 << 16;
  let times = new Float64Array(capacity);
  let cols = Object.fromEntries(VALUE_COLUMNS.map((c) => [c, new Float32Array(capacity)])) as Record<
    ValueColumn,
    Float32Array
  >;
  let index: number[] = [];
  let timeIndex = -1;
  let n = 0;

  const grow = () => {
    capacity *= 2;
    const t = new Float64Array(capacity);
    t.set(times);
    times = t;
    for (const c of VALUE_COLUMNS) {
      const a = new Float32Array(capacity);
      a.set(cols[c]);
      cols[c] = a;
    }
  };

  for await (const line of lines) {
    if (!line) continue;
    const fields = line.split(",");
    if (timeIndex < 0) {
      timeIndex = fields.indexOf("datetime");
      index = VALUE_COLUMNS.map((c) => fields.indexOf(c));
      const missing = VALUE_COLUMNS.filter((_, k) => index[k] < 0);
      if (timeIndex < 0 || missing.length) {
        throw new Error(`Dataset ${file} is missing columns: ${["datetime", ...missing].join(", ")}`);
      }
      continue;
    }
    if (n === capacity) grow();
    times[n] = parseNaive(fields[timeIndex]);
    for (let k = 0; k < VALUE_COLUMNS.length; k++) {
      // Float32Array assignment rounds to float32, as pandas' dtype=float32 did.
      cols[VALUE_COLUMNS[k]][n] = Number(fields[index[k]]);
    }
    n++;
  }

  // Trim to size so the unused tail isn't held for the life of the process.
  times = times.slice(0, n);
  cols = Object.fromEntries(VALUE_COLUMNS.map((c) => [c, cols[c].slice(0, n)])) as typeof cols;
  console.log(`[Dataset] Loaded ${n.toLocaleString()} rows from ${file} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return new Dataset(n, times, cols, file);
}
