import type { ReactNode } from "react";

/**
 * One measured figure.
 *
 * Replaces three families that differed only in type size: the admin gauge
 * (written inline in admin/page.tsx), the consumer `Stat` (a near-identical
 * copy in consumer/page.tsx) and the savings/cost headline. A gauge and a
 * headline are the same object at two sizes, so they are now one component
 * with a `hero` flag.
 *
 * `triggered` is the gauge case: the parameter is over its live threshold. It
 * shows as a tinted fill, a coloured value and a filled dot — three signals,
 * so the state survives greyscale and colour-vision deficiency alike.
 */
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
