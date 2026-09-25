/**
 * Filter vocabularies shared by the admin tables.
 *
 * `SEVERITIES` and `PARAMETERS` were declared identically at the top of both
 * alerts/page.tsx and participation/page.tsx. They are the backend's own
 * vocabularies — `severity` from the server constants and `parameter` from
 * PARAMETER_META — so a page-local copy is a copy of a wire contract.
 *
 * NOTE the parameter values are the backend's `parameter` keys
 * ("reserve_margin"), not PARAMETER_CONFIGS' display key ("reserve").
 */

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
 * Values match the predicates in src/app/api/alerts/route.ts — the same four
 * states `Alert.outcome` derives, expressed as a filter.
 */
export const OUTCOMES: { value: string; label: string }[] = [
  { value: "", label: "Any outcome" },
  { value: "pending", label: "Pending" },
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
