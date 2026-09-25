"use client";

import { useState } from "react";
import { apiSetThresholds } from "@/hooks/useGridWebSocket";
import { Icon } from "@/components/Icon";
import { Notice } from "@/components/Notice";
import {
  DEFAULT_THRESHOLDS,
  PARAMETER_CONFIGS,
  type GridState,
  type Thresholds,
} from "@/lib/types";

/**
 * Retune what the engine alerts on.
 *
 * `POST /api/thresholds` has always been able to do this and there was no way
 * to reach it from the console — the dashboard carried a comment saying as
 * much. Six numbers decide everything this product does: which alerts fire,
 * what the household's verdict says, which gauges light. Leaving them
 * adjustable only by curl made the six-parameter model a fixed demo.
 *
 * Two things the panel does that a bare form would not:
 *
 * - **Each row shows the parameter's live value next to its line.** A
 *   threshold in isolation is unanswerable; "reserve margin 10%" means nothing
 *   until you can see it is sitting at 18% right now. This is the difference
 *   between tuning and guessing.
 * - **Each row says which direction trips it.** `< 10%` and `> 1.5×` are both
 *   "the threshold", and which side is the problem is not recoverable from the
 *   number.
 *
 * Order is `PARAMETER_CONFIGS`, which is `config.PARAMETER_META`'s priority
 * order — the same sequence the gauges above read in and the same one the
 * engine breaks a severity tie with.
 */
export function ThresholdPanel({
  thresholds,
  gridState,
  onClose,
}: {
  /** Live, from the socket. Falls back to the compiled-in defaults. */
  thresholds: Thresholds | null;
  /** For the "sitting at" readout beside each slider. */
  gridState: GridState | null;
  onClose: () => void;
}) {
  // A local working copy: the operator drags six sliders and commits once.
  // Posting per-drag would audit every intermediate value and retune the
  // running engine mid-gesture.
  const [draft, setDraft] = useState<Thresholds>(thresholds ?? DEFAULT_THRESHOLDS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applied = thresholds ?? DEFAULT_THRESHOLDS;
  const dirty = PARAMETER_CONFIGS.some(
    (c) => draft[c.tuning.key] !== applied[c.tuning.key]
  );
  const atDefaults = PARAMETER_CONFIGS.every(
    (c) => draft[c.tuning.key] === DEFAULT_THRESHOLDS[c.tuning.key]
  );

  async function apply() {
    setSaving(true);
    setError(null);
    const ok = await apiSetThresholds(draft);
    setSaving(false);
    if (ok) {
      // Nothing to set locally — the backend broadcasts `thresholds` to every
      // admin socket including this one, which is what relabels the gauges.
      onClose();
    } else {
      setError("The backend rejected the change. The engine is still on the old values.");
    }
  }

  return (
    <div
      className="ds-sheet-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Alert thresholds"
      // Click-outside closes. The panel itself stops the bubble below, so only
      // the scrim is a target — a drag that ends outside a slider must not be
      // read as a dismissal.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ds-sheet-panel__body">
        <div className="ds-sheet-panel__head">
          <div>
            <h2 className="ds-header__title">Alert thresholds</h2>
            <p className="ds-header__sub">
              What counts as a problem. Applies to the running engine
              immediately.
            </p>
          </div>
          <button
            className="ds-btn ds-btn--ghost ds-btn--icon"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <Notice tone="error" title={error} />}

        <div className="ds-stack ds-stack--sm">
          {PARAMETER_CONFIGS.map((config) => {
            const t = config.tuning;
            const live = gridState
              ? (gridState.parameters[config.valueKey] as number)
              : null;
            const triggered = gridState
              ? (gridState.parameters[config.triggeredKey] as boolean)
              : false;

            return (
              <div key={config.key} className="ds-card ds-card--pad-sm ds-stack ds-stack--sm">
                <div className="ds-tune__head">
                  <span className="ds-tune__name">{config.label}</span>
                  <span className="ds-tune__value">
                    {t.direction === "above" ? "over " : "under "}
                    {t.format(draft[t.key])}
                  </span>
                </div>

                <input
                  type="range"
                  className="ds-range ds-range--wide"
                  min={t.min}
                  max={t.max}
                  step={t.step}
                  value={draft[t.key]}
                  aria-label={`${config.label} threshold`}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [t.key]: Number(e.target.value) }))
                  }
                />

                <div className="ds-tune__foot">
                  <span>
                    {t.format(t.min)} – {t.format(t.max)}
                  </span>
                  {/* The whole reason this panel is usable: where the signal
                      actually is, beside the line you are moving. */}
                  <span className={triggered ? "ds-tune__live--hot" : undefined}>
                    {live === null
                      ? "no reading yet"
                      : `now ${config.format(live)}${triggered ? " · over the line" : ""}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="ds-modal__actions">
          <button
            className="ds-btn"
            disabled={saving || atDefaults}
            onClick={() => setDraft(DEFAULT_THRESHOLDS)}
            title="Back to the default thresholds"
          >
            Restore defaults
          </button>
          <button
            className="ds-btn ds-btn--primary"
            disabled={saving || !dirty}
            onClick={apply}
          >
            {saving ? "Applying…" : "Apply"}
          </button>
        </div>

        <p className="ds-muted ds-muted--xs">
          Recorded in the audit log with the previous values, and pushed to every
          open dashboard.
        </p>
      </div>
    </div>
  );
}
