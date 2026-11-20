import type { ReactNode } from "react";

/** One measured figure. */
export function Metric({
  label,
  value,
  sub,
  triggered,
  hero,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Gauge is over its threshold. Renders the dot as well as the tint. */
  triggered?: boolean;
  /** Headline size, no box of its own. */
  hero?: boolean;
  className?: string;
}) {
  const cls = [
    "ds-metric",
    hero ? "ds-metric--hero" : "",
    triggered ? "ds-metric--triggered" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <span className="ds-metric__label">
        {triggered !== undefined && <span className="ds-metric__flag" aria-hidden />}
        {label}
      </span>
      <span className="ds-metric__value">{value}</span>
      {sub && <span className="ds-metric__sub">{sub}</span>}
    </div>
  );
}
