/** Filter vocabularies shared by the admin tables. */

/** Leading "" is the "any" option. */
export const SEVERITIES = ["", "info", "warning", "critical", "emergency"] as const;

/** Ordered by PARAMETER_META priority — most urgent first, as the engine ranks. */
export const PARAMETERS = [
  "",
  "emergency",
  "frequency",
  "reserve_margin",
  "peak_load",
  "renewable",
  "price",
] as const;

/**
 * How long a pushed alert may wait for the gateway's `forward_alert` echo before it counts as not
 * delivered.
 */
export const DELIVERY_GRACE_MS = 10_000;

/** Values match the outcome predicates in src/app/api/alerts/route.ts. */
export const OUTCOMES: { value: string; label: string }[] = [
  { value: "", label: "Any outcome" },
  { value: "pending", label: "Pending" },
  { value: "sending", label: "Sending" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Not delivered" },
  { value: "ignored", label: "Ignored" },
];

/** Human labels for a `parameter` key, used by the savings breakdown and tables. */
export const PARAMETER_LABELS: Record<string, string> = {
  emergency: "Grid emergency",
  frequency: "Frequency instability",
  reserve_margin: "Low spinning reserve",
  peak_load: "Peak demand",
  renewable: "Low renewables",
  price: "Price spike",
};
