/** Display formatting shared by the admin tables. */

/** A timestamp in the reader's locale, or an em dash when there isn't one. */
export function fmt(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}
