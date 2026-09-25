"""
DSM Data Pipeline — Configuration
All thresholds, constants, and scaling factors in one place.
Tunable without modifying transformation logic.
"""

# =============================================================================
# Grid Adaptation (European dataset → Indonesian PLN grid)
# =============================================================================
VOLTAGE_NOMINAL_ORIGINAL = 230.0   # European nominal (V)
VOLTAGE_NOMINAL_TARGET = 220.0     # Indonesian PLN nominal (V)
VOLTAGE_SCALE_FACTOR = VOLTAGE_NOMINAL_TARGET / VOLTAGE_NOMINAL_ORIGINAL  # ≈ 0.9565

GRID_FREQUENCY_HZ = 50.0          # Indonesian grid frequency (same as EU)

# =============================================================================
# Scaling — Single household → Neighborhood (RT)
# =============================================================================
NEIGHBORHOOD_SCALE_FACTOR = 150    # Number of homes in the neighborhood

# =============================================================================
# Parameter 1: Peak Load Forecast
# =============================================================================
EMA_SPAN_MINUTES = 60             # EMA lookback window (minutes)
PEAK_LOAD_THRESHOLD_RATIO = 1.5   # Trigger when actual/forecast > this ratio
PEAK_LOAD_PERCENTILE = 90         # Historical percentile for peak reference

# =============================================================================
# Parameter 2: System Frequency Deviation
# =============================================================================
DROOP_CONSTANT_K = 1.0            # Hz per p.u. load change
FREQUENCY_NOISE_STD = 0.02        # Gaussian noise std dev (Hz)
FREQ_DEVIATION_THRESHOLD_HZ = 0.2 # Trigger when |Δf| > this value

# =============================================================================
# Parameter 3: Reserve Margin / Spinning Reserve
# =============================================================================
# System capacity = peak × this factor (5% headroom → triggers near peaks)
CAPACITY_HEADROOM_FACTOR = 1.05
RESERVE_MARGIN_CRITICAL_PCT = 10  # Trigger when reserve < this %
RESERVE_MARGIN_WARNING_PCT = 15   # Warning level

# =============================================================================
# Parameter 4: Renewable Energy Forecast
# =============================================================================
# Solar parameters (tropical Indonesia: ~12h days year-round)
SOLAR_CAPACITY_FRACTION = 0.25    # Solar capacity as fraction of system capacity
SOLAR_SUNRISE_HOUR = 6.0          # Sunrise hour (local time)
SOLAR_SUNSET_HOUR = 18.0          # Sunset hour (local time)

# Wind parameters (Ornstein-Uhlenbeck process)
WIND_CAPACITY_FRACTION = 0.10     # Wind capacity as fraction of system capacity
WIND_OU_THETA = 0.15              # Mean-reversion speed
WIND_OU_MU = 0.5                  # Long-term mean (fraction of capacity)
WIND_OU_SIGMA = 0.1               # Volatility

# Combined renewable threshold
LOW_RENEWABLE_THRESHOLD = 0.15    # Trigger when renewable fraction < 15%

# =============================================================================
# Parameter 5: Emergency Condition / Contingency
# =============================================================================
VOLTAGE_DEVIATION_THRESHOLD_PCT = 5.0   # ±5% of nominal (220V)
POWER_RAMP_ZSCORE_THRESHOLD = 3.0       # z-score of dP/dt for alarm
APPARENT_POWER_OVERLOAD_FACTOR = 0.95   # Trigger when S > 95% of capacity

# Emergency composite weights (must sum to 1.0)
EMERGENCY_WEIGHT_VOLTAGE = 0.35
EMERGENCY_WEIGHT_RAMP = 0.30
EMERGENCY_WEIGHT_OVERLOAD = 0.35
EMERGENCY_SCORE_THRESHOLD = 0.6         # Trigger when composite > this

# =============================================================================
# Parameter 6: Wholesale/Retail Electricity Price (IDR)
# =============================================================================
# PLN-inspired Time-of-Use base prices (IDR/kWh)
PRICE_OFF_PEAK_IDR = 900           # 23:00 – 06:00
PRICE_SHOULDER_IDR = 1200          # 06:00 – 09:00, 21:00 – 23:00
PRICE_PEAK_IDR = 1500              # 09:00 – 21:00

# Dynamic price adjustment coefficients
PRICE_RESERVE_ALPHA = 0.5          # Sensitivity to reserve margin
PRICE_DEMAND_BETA = 0.3            # Sensitivity to peak load ratio

# Price spike
PRICE_SPIKE_MULTIPLIER = 3.0       # During emergency/low reserve
PRICE_SPIKE_THRESHOLD_RATIO = 2.0  # Trigger when price > 2× normal

# Retail margin over wholesale
RETAIL_MARGIN_FACTOR = 1.35        # Retail = wholesale × this

# =============================================================================
# Time-of-Use hour definitions
# =============================================================================
TOU_SCHEDULE = {
    "off_peak": [(23, 24), (0, 6)],       # 23:00–06:00
    "shoulder": [(6, 9), (21, 23)],         # 06:00–09:00, 21:00–23:00
    "peak":     [(9, 21)],                  # 09:00–21:00
}
