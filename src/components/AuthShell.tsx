import type { ReactNode } from "react";
import { BrinEmblem } from "./Brand";

/** The sign-in / registration shell: form on the left, grid artwork on the right. */
export function AuthShell({
  subtitle,
  children,
}: {
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="ds-auth-split">
      <div className="ds-auth-split__form">
        <div className="ds-auth">
          <header className="ds-auth__brand">
            <BrinEmblem size={56} className="ds-auth__partner" />
            <h1 className="ds-auth__title">DSM Grid</h1>
            <p className="ds-header__sub">{subtitle}</p>
            <p className="ds-auth__collab">
              In collaboration with Badan Riset dan Inovasi Nasional (BRIN)
            </p>
          </header>
          {children}
        </div>
      </div>

      <aside className="ds-auth-split__art" aria-hidden="true">
        <GridArtwork />
      </aside>
    </div>
  );
}

// A frequency trace that wanders inside its band, drawn once when the page loads.
const TRACE = Array.from({ length: 61 }, (_, i) => {
  const x = i * 10;
  const y = 200 + 34 * Math.sin(i / 4.2) + 14 * Math.sin(i / 1.7 + 1) + 6 * Math.sin(i * 1.3);
  return `${i ? "L" : "M"}${x},${y.toFixed(1)}`;
}).join("");

/** The panel: the dashboard's frequency scope, at rest. */
function GridArtwork() {
  return (
    <div className="ds-artwork">
      <svg className="ds-artwork__trace" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
        <rect className="ds-artwork__band" x="0" y="130" width="600" height="140" />
        <line className="ds-artwork__limit" x1="0" x2="600" y1="130" y2="130" />
        <line className="ds-artwork__limit" x1="0" x2="600" y1="270" y2="270" />
        <path className="ds-artwork__wave" d={TRACE} pathLength={1} />
      </svg>

      <p className="ds-artwork__readout">
        <span className="ds-artwork__reading">50.00</span>
        <span className="ds-artwork__unit">Hz</span>
        <span className="ds-artwork__caption">Grid frequency, allowed 50 ± 0.20 Hz</span>
      </p>
    </div>
  );
}
