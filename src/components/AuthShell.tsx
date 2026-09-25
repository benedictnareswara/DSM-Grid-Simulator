import type { ReactNode } from "react";

/**
 * The sign-in / registration shell: form on the left, grid artwork on the right.
 *
 * Both auth pages share the centred column this replaced — it carried the same
 * three-element branding block and the same 400px width, twice. That part is
 * unchanged; what is new is the panel beside it.
 *
 * ## The artwork is drawn, not shipped
 *
 * No image file. It is a layered radial-gradient mesh with an inline SVG trace
 * over it, which means it costs nothing to download, scales to any panel size
 * without a second asset, and recolours from the same tokens as the rest of
 * the page — so it is correct in dark mode by construction rather than by
 * having a second export.
 *
 * The trace is a frequency line, not decoration for its own sake: this is the
 * sign-in page for a grid console, and the readings floating on it are the
 * ones the console is about. It animates by drifting a dash offset, which the
 * global `prefers-reduced-motion` block already zeroes.
 *
 * Below 900px the panel is removed entirely and the form centres, which is
 * what the old layout did at every width.
 */
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
            <p className="ds-eyebrow">Demand Side Management</p>
            <h1 className="ds-auth__title">DSM Grid</h1>
            <p className="ds-header__sub">{subtitle}</p>
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

/**
 * The panel's contents. Purely decorative — the whole `<aside>` is
 * `aria-hidden`, so nothing here needs a text alternative and nothing here
 * may carry information the form does not.
 */
function GridArtwork() {
  return (
    <div className="ds-artwork">
      <div className="ds-artwork__mesh" />

      <svg
        className="ds-artwork__trace"
        viewBox="0 0 600 400"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        {/* Three passes of the same wave at different amplitudes and speeds.
            One line reads as a logo; three read as a signal. */}
        <path
          className="ds-artwork__wave ds-artwork__wave--1"
          d="M-50 200 Q 25 120 100 200 T 250 200 T 400 200 T 550 200 T 700 200"
        />
        <path
          className="ds-artwork__wave ds-artwork__wave--2"
          d="M-50 230 Q 50 180 150 230 T 350 230 T 550 230 T 750 230"
        />
        <path
          className="ds-artwork__wave ds-artwork__wave--3"
          d="M-50 170 Q 60 235 170 170 T 390 170 T 610 170"
        />
      </svg>

      {/* The six parameters, as the console would print them. Values are
          static: this page has no session, so it has no readings — inventing
          live-looking ones would be a lie told by the login screen. */}
      <div className="ds-artwork__readout">
        <Reading label="Frequency" value="50.00 Hz" />
        <Reading label="Reserve" value="18.4%" />
        <Reading label="Peak load" value="1.24×" />
        <Reading label="Renewables" value="31.5%" />
      </div>

      <p className="ds-artwork__strap">
        220V · 50Hz
        <span>Neighborhood scale</span>
      </p>
    </div>
  );
}

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <span className="ds-artwork__reading">
      <span className="ds-artwork__readinglabel">{label}</span>
      <span className="ds-artwork__readingvalue">{value}</span>
    </span>
  );
}
