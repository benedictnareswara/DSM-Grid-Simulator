import type { ReactNode } from "react";

/** The filter row above every admin table. */

export type FilterOption = {
  value: string;
  label: string;
};

/** `["", "warning", …]` → options whose blank entry reads as `emptyLabel`. */
export function options(values: readonly string[], emptyLabel: string): FilterOption[] {
  return values.map((v) => ({ value: v, label: v || emptyLabel }));
}

/** One labelled `<select>` in a filter row. Use `options()` to build `choices`. */
export function FilterSelect({
  value,
  onChange,
  choices,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: FilterOption[];
  /** Accessible name — these selects have no visible label. */
  label: string;
}) {
  return (
    <select
      className="ds-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

/** A row of filters with a Clear control. */
export function FilterBar({
  children,
  active,
  onClear,
  trailing,
}: {
  children: ReactNode;
  /** Whether anything is filtered. Drives whether Clear is offered at all. */
  active: boolean;
  onClear: () => void;
  /** Right-hand content, e.g. a result count. */
  trailing?: ReactNode;
}) {
  return (
    <div className="ds-filters">
      {children}
      {active && (
        <button className="ds-btn ds-btn--sm" onClick={onClear}>
          Clear
        </button>
      )}
      {trailing && <span className="ds-filters__trailing">{trailing}</span>}
    </div>
  );
}
