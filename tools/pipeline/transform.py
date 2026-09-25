"""
DSM Data Pipeline — Transform Script
Loads the raw household power dataset, cleans it, and derives all 6 grid-side
parameters as new columns. Outputs a transformed CSV ready for the simulator.

Usage (from the repo root):
    python tools/pipeline/transform.py [--raw PATH] [--out PATH]

--raw takes the UCI zip as downloaded, the .txt inside it, or a comma-separated
copy. See tools/pipeline/README.md.
"""

import argparse
import io
import os
import time
import zipfile

import numpy as np
import pandas as pd

from config import (
    APPARENT_POWER_OVERLOAD_FACTOR,
    # P3: Reserve Margin
    CAPACITY_HEADROOM_FACTOR,
    # P2: Frequency
    DROOP_CONSTANT_K,
    # P1: Peak Load
    EMA_SPAN_MINUTES,
    EMERGENCY_SCORE_THRESHOLD,
    EMERGENCY_WEIGHT_OVERLOAD,
    EMERGENCY_WEIGHT_RAMP,
    EMERGENCY_WEIGHT_VOLTAGE,
    FREQ_DEVIATION_THRESHOLD_HZ,
    FREQUENCY_NOISE_STD,
    GRID_FREQUENCY_HZ,
    LOW_RENEWABLE_THRESHOLD,
    # Scaling
    NEIGHBORHOOD_SCALE_FACTOR,
    PEAK_LOAD_THRESHOLD_RATIO,
    POWER_RAMP_ZSCORE_THRESHOLD,
    PRICE_DEMAND_BETA,
    # P6: Price
    PRICE_OFF_PEAK_IDR,
    PRICE_PEAK_IDR,
    PRICE_RESERVE_ALPHA,
    PRICE_SHOULDER_IDR,
    PRICE_SPIKE_MULTIPLIER,
    PRICE_SPIKE_THRESHOLD_RATIO,
    RESERVE_MARGIN_CRITICAL_PCT,
    RETAIL_MARGIN_FACTOR,
    # P4: Renewables
    SOLAR_CAPACITY_FRACTION,
    SOLAR_SUNRISE_HOUR,
    SOLAR_SUNSET_HOUR,
    # P5: Emergency
    VOLTAGE_DEVIATION_THRESHOLD_PCT,
    VOLTAGE_NOMINAL_TARGET,
    # Grid adaptation
    VOLTAGE_SCALE_FACTOR,
    WIND_CAPACITY_FRACTION,
    WIND_OU_MU,
    WIND_OU_SIGMA,
    WIND_OU_THETA,
)

# ─── Paths ───────────────────────────────────────────────────────────────────
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# The UCI archive exactly as downloaded, and the one file inside it. Read
# straight out of the zip rather than extracted: 127 MB of disk saved, and no
# hand-converted intermediate to go stale.
RAW_ZIP = os.path.join(_ROOT, "data", "household_power_consumption.zip")
RAW_MEMBER = "household_power_consumption.txt"
# Where the app looks for DATASET=full. pandas gzips it because of the extension.
OUTPUT_CSV = os.path.join(_ROOT, "data", "full.csv.gz")


def _open_raw(path: str) -> io.TextIOBase:
    """Open the raw data as text, whether it is the zip or a file on disk."""
    if zipfile.is_zipfile(path):
        archive = zipfile.ZipFile(path)
        return io.TextIOWrapper(archive.open(RAW_MEMBER), encoding="utf-8")
    return open(path, encoding="utf-8")


def load_and_clean(path: str) -> pd.DataFrame:
    """Load the raw data, parse dates, handle missing values."""
    print("[1/8] Loading raw dataset...")
    t0 = time.time()

    # UCI ships `;`-separated. Older setups of this repo converted it to `,`
    # by hand, so accept either, decided by the header line.
    with _open_raw(path) as fh:
        sep = ";" if ";" in fh.readline() else ","
    with _open_raw(path) as fh:
        df = pd.read_csv(
            fh,
            sep=sep,
            na_values=["?", ""],
            low_memory=False,
        )

    # Combine Date + Time into a proper datetime index
    df["datetime"] = pd.to_datetime(
        df["Date"] + " " + df["Time"], format="%d/%m/%Y %H:%M:%S"
    )
    df = df.sort_values("datetime").reset_index(drop=True)

    # Drop original Date/Time columns (we have datetime now)
    df = df.drop(columns=["Date", "Time"])

    # Forward-fill then back-fill missing values (small gaps only)
    numeric_cols = df.select_dtypes(include=[np.number]).columns
    df[numeric_cols] = df[numeric_cols].ffill(limit=10)
    df[numeric_cols] = df[numeric_cols].bfill(limit=10)

    # Drop any remaining rows with NaN (very few, if any)
    before = len(df)
    df = df.dropna(subset=numeric_cols).reset_index(drop=True)
    after = len(df)
    if before != after:
        print(f"    Dropped {before - after} rows with remaining NaN values")

    print(f"    Loaded {len(df):,} rows in {time.time() - t0:.1f}s")
    return df


def adapt_to_indonesian_grid(df: pd.DataFrame) -> pd.DataFrame:
    """Rescale voltage from European 230V to Indonesian 220V nominal."""
    print("[2/8] Adapting to Indonesian PLN grid (220V / 50Hz)...")
    df["Voltage"] = df["Voltage"] * VOLTAGE_SCALE_FACTOR
    return df


def derive_peak_load_forecast(df: pd.DataFrame) -> pd.DataFrame:
    """Parameter 1: Peak Load Forecast using EMA baseline."""
    print("[3/8] Deriving peak load forecast...")

    # EMA-smoothed load forecast
    df["load_forecast_ema"] = (
        df["Global_active_power"]
        .ewm(span=EMA_SPAN_MINUTES, adjust=False)
        .mean()
    )

    # Peak load ratio: actual vs forecast
    df["peak_load_ratio"] = df["Global_active_power"] / df["load_forecast_ema"].clip(lower=0.01)

    # Trigger flag
    df["peak_load_triggered"] = df["peak_load_ratio"] > PEAK_LOAD_THRESHOLD_RATIO

    return df


def derive_frequency_deviation(df: pd.DataFrame) -> pd.DataFrame:
    """Parameter 2: System Frequency Deviation via swing equation proxy."""
    print("[4/8] Deriving frequency deviation...")

    # Rate of change of active power (kW/min)
    df["dP_dt"] = df["Global_active_power"].diff().fillna(0)

    # Nominal power base (mean of the dataset)
    p_base = df["Global_active_power"].mean()

    # Simulated frequency: f = f_nominal - K * (dP/dt / P_base)
    np.random.seed(42)  # Reproducibility
    noise = np.random.normal(0, FREQUENCY_NOISE_STD, size=len(df))

    df["frequency_hz"] = (
        GRID_FREQUENCY_HZ
        - DROOP_CONSTANT_K * (df["dP_dt"] / p_base)
        + noise
    )

    # Clamp to reasonable range (49.0 – 51.0 Hz)
    df["frequency_hz"] = df["frequency_hz"].clip(49.0, 51.0)

    # Deviation from nominal
    df["freq_deviation_hz"] = df["frequency_hz"] - GRID_FREQUENCY_HZ

    # Trigger flag
    df["freq_deviation_triggered"] = df["freq_deviation_hz"].abs() > FREQ_DEVIATION_THRESHOLD_HZ

    return df


def derive_reserve_margin(df: pd.DataFrame) -> pd.DataFrame:
    """Parameter 3: Reserve Margin / Spinning Reserve."""
    print("[5/8] Deriving reserve margin...")

    # Scale up to neighborhood level
    df["neighborhood_demand_kw"] = df["Global_active_power"] * NEIGHBORHOOD_SCALE_FACTOR

    # System capacity based on historical peak with headroom
    peak_demand = df["neighborhood_demand_kw"].max()
    system_capacity = peak_demand * CAPACITY_HEADROOM_FACTOR
    df["system_capacity_kw"] = system_capacity  # Constant for reference

    # Reserve margin percentage
    df["reserve_margin_pct"] = (
        (system_capacity - df["neighborhood_demand_kw"]) / system_capacity * 100
    )

    # Trigger flag
    df["spinning_reserve_triggered"] = df["reserve_margin_pct"] < RESERVE_MARGIN_CRITICAL_PCT

    return df


def derive_renewable_forecast(df: pd.DataFrame) -> pd.DataFrame:
    """Parameter 4: Renewable Energy Forecast (solar + wind synthetic signals)."""
    print("[6/8] Deriving renewable energy forecast...")

    system_capacity = df["system_capacity_kw"].iloc[0]

    # ── Solar: sinusoidal curve (tropical Indonesia ≈ 12h days year-round) ──
    hours = df["datetime"].dt.hour + df["datetime"].dt.minute / 60.0
    solar_capacity = system_capacity * SOLAR_CAPACITY_FRACTION

    # Solar output: half-sine during daylight hours, zero at night
    solar_fraction = np.where(
        (hours >= SOLAR_SUNRISE_HOUR) & (hours <= SOLAR_SUNSET_HOUR),
        np.sin(np.pi * (hours - SOLAR_SUNRISE_HOUR) / (SOLAR_SUNSET_HOUR - SOLAR_SUNRISE_HOUR)),
        0.0,
    )
    # Add some daily cloud variability (±20%)
    np.random.seed(123)
    day_number = (df["datetime"] - df["datetime"].iloc[0]).dt.days
    daily_cloud = 0.8 + 0.4 * np.random.rand(day_number.max() + 1)
    cloud_factor = daily_cloud[day_number.values]
    df["solar_output_kw"] = solar_capacity * solar_fraction * cloud_factor

    # ── Wind: Ornstein-Uhlenbeck process ──
    wind_capacity = system_capacity * WIND_CAPACITY_FRACTION
    np.random.seed(456)
    n = len(df)
    wind_ou = np.zeros(n)
    wind_ou[0] = WIND_OU_MU
    for i in range(1, n):
        wind_ou[i] = (
            wind_ou[i - 1]
            + WIND_OU_THETA * (WIND_OU_MU - wind_ou[i - 1])
            + WIND_OU_SIGMA * np.random.randn()
        )
    wind_ou = np.clip(wind_ou, 0, 1)
    df["wind_output_kw"] = wind_capacity * wind_ou

    # ── Combined renewable fraction ──
    total_renewable = df["solar_output_kw"] + df["wind_output_kw"]
    df["renewable_fraction"] = total_renewable / system_capacity

    # Trigger flag
    df["low_renewable_triggered"] = df["renewable_fraction"] < LOW_RENEWABLE_THRESHOLD

    return df


def derive_emergency_condition(df: pd.DataFrame) -> pd.DataFrame:
    """Parameter 5: Emergency Condition / Contingency (composite score)."""
    print("[7/8] Deriving emergency condition...")

    # ── Sub-indicator 1: Voltage anomaly ──
    df["voltage_deviation_pct"] = (
        (df["Voltage"] - VOLTAGE_NOMINAL_TARGET).abs() / VOLTAGE_NOMINAL_TARGET * 100
    )
    voltage_score = (df["voltage_deviation_pct"] / VOLTAGE_DEVIATION_THRESHOLD_PCT).clip(0, 1)

    # ── Sub-indicator 2: Power ramp z-score ──
    dP_mean = df["dP_dt"].mean()
    dP_std = df["dP_dt"].std()
    df["power_ramp_zscore"] = ((df["dP_dt"] - dP_mean) / dP_std).abs()
    ramp_score = (df["power_ramp_zscore"] / POWER_RAMP_ZSCORE_THRESHOLD).clip(0, 1)

    # ── Sub-indicator 3: Apparent power overload ──
    df["apparent_power_kva"] = np.sqrt(
        df["Global_active_power"] ** 2 + df["Global_reactive_power"] ** 2
    )
    system_capacity = df["system_capacity_kw"].iloc[0] / NEIGHBORHOOD_SCALE_FACTOR  # per-household
    overload_threshold = system_capacity * APPARENT_POWER_OVERLOAD_FACTOR
    overload_score = (df["apparent_power_kva"] / overload_threshold).clip(0, 1)

    # ── Composite emergency score ──
    df["emergency_score"] = (
        EMERGENCY_WEIGHT_VOLTAGE * voltage_score
        + EMERGENCY_WEIGHT_RAMP * ramp_score
        + EMERGENCY_WEIGHT_OVERLOAD * overload_score
    )

    # Trigger flag
    df["emergency_triggered"] = df["emergency_score"] > EMERGENCY_SCORE_THRESHOLD

    return df


def derive_electricity_price(df: pd.DataFrame) -> pd.DataFrame:
    """Parameter 6: Wholesale/Retail Electricity Price (IDR)."""
    print("[8/8] Deriving electricity price...")

    hours = df["datetime"].dt.hour

    # Time-of-Use base price
    tou_price = np.full(len(df), PRICE_SHOULDER_IDR, dtype=float)

    # Off-peak: 23:00–06:00
    off_peak_mask = (hours >= 23) | (hours < 6)
    tou_price[off_peak_mask] = PRICE_OFF_PEAK_IDR

    # Peak: 09:00–21:00
    peak_mask = (hours >= 9) & (hours < 21)
    tou_price[peak_mask] = PRICE_PEAK_IDR

    df["tou_base_price_idr"] = tou_price

    # Dynamic adjustment based on reserve margin and demand ratio
    reserve_factor = 1 + PRICE_RESERVE_ALPHA * (1 - df["reserve_margin_pct"] / 100).clip(0, 1)
    demand_factor = 1 + PRICE_DEMAND_BETA * (df["peak_load_ratio"] - 1).clip(0, None)

    df["wholesale_price_idr"] = df["tou_base_price_idr"] * reserve_factor * demand_factor

    # Price spike during emergency or low reserve
    spike_mask = df["emergency_triggered"] | df["spinning_reserve_triggered"]
    df.loc[spike_mask, "wholesale_price_idr"] *= PRICE_SPIKE_MULTIPLIER

    # Retail price
    df["retail_price_idr"] = df["wholesale_price_idr"] * RETAIL_MARGIN_FACTOR

    # Price spike trigger
    normal_price = df["tou_base_price_idr"] * RETAIL_MARGIN_FACTOR
    df["price_spike_triggered"] = df["retail_price_idr"] > (
        normal_price * PRICE_SPIKE_THRESHOLD_RATIO
    )

    return df


def print_summary(df: pd.DataFrame):
    """Print a summary of the derived parameters."""
    print("\n" + "=" * 70)
    print("TRANSFORMATION SUMMARY")
    print("=" * 70)

    print(f"\nTotal rows: {len(df):,}")
    print(f"Date range: {df['datetime'].min()} → {df['datetime'].max()}")
    print(f"Columns: {len(df.columns)}")

    triggered_cols = [c for c in df.columns if c.endswith("_triggered")]
    print(f"\n{'Parameter':<35} {'Triggered':>10} {'% of rows':>10}")
    print("-" * 57)
    for col in triggered_cols:
        count = df[col].sum()
        pct = count / len(df) * 100
        name = col.replace("_triggered", "").replace("_", " ").title()
        print(f"{name:<35} {count:>10,} {pct:>9.2f}%")

    print(f"\n{'Derived Column':<35} {'Min':>12} {'Max':>12} {'Mean':>12}")
    print("-" * 73)
    summary_cols = [
        "load_forecast_ema", "peak_load_ratio",
        "frequency_hz", "freq_deviation_hz",
        "neighborhood_demand_kw", "reserve_margin_pct",
        "solar_output_kw", "wind_output_kw", "renewable_fraction",
        "voltage_deviation_pct", "emergency_score", "apparent_power_kva",
        "wholesale_price_idr", "retail_price_idr",
    ]
    for col in summary_cols:
        if col in df.columns:
            print(
                f"{col:<35} {df[col].min():>12.3f} {df[col].max():>12.3f} {df[col].mean():>12.3f}"
            )

    print("=" * 70)


def main() -> None:
    """
    Run the whole offline transform: raw UCI data in, replay dataset out.

    Slow and memory-hungry by nature — it reads a 127 MB text file and writes a
    far larger one — and is needed only after editing tools/pipeline/config.py,
    since the server replays the output rather than recomputing it.
    """
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--raw", default=RAW_ZIP,
                        help="UCI zip, the .txt inside it, or a comma-separated copy")
    parser.add_argument("--out", default=OUTPUT_CSV, help="where to write the replay dataset")
    args = parser.parse_args()
    output_csv = args.out

    t_start = time.time()
    print("=" * 70)
    print(f"DSM DATA PIPELINE — Transforming {os.path.basename(args.raw)}")
    print("=" * 70)

    # Load & clean
    df = load_and_clean(args.raw)

    # Adapt to Indonesian grid
    df = adapt_to_indonesian_grid(df)

    # Derive all 6 parameters (order matters — some depend on earlier ones)
    df = derive_peak_load_forecast(df)        # P1
    df = derive_frequency_deviation(df)        # P2
    df = derive_reserve_margin(df)             # P3
    df = derive_renewable_forecast(df)         # P4
    df = derive_emergency_condition(df)        # P5
    df = derive_electricity_price(df)          # P6 (depends on P1, P3, P5)

    # Summary
    print_summary(df)

    # Save
    # Written under a temporary name and renamed into place, so an interrupted
    # run never leaves a truncated file the server would take as finished.
    print(f"\nSaving transformed dataset to: {output_csv}")
    partial = output_csv + ".partial"
    compression = "gzip" if output_csv.endswith(".gz") else None
    df.to_csv(partial, index=False, compression=compression)
    os.replace(partial, output_csv)
    file_size_mb = os.path.getsize(output_csv) / (1024 * 1024)
    print(f"Output file size: {file_size_mb:.1f} MB")
    print(f"Total pipeline time: {time.time() - t_start:.1f}s")
    print("Done! ✅")


if __name__ == "__main__":
    main()
