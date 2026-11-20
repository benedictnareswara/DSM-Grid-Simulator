"use client";

import { useState } from "react";
import { apiPushTestAlert } from "@/hooks/useGridWebSocket";
import { Icon } from "@/components/Icon";
import { Notice } from "@/components/Notice";
import { PARAMETER_LABELS, PARAMETERS, SEVERITIES } from "@/lib/constants";
import { defaultWindowMinutes, idr, kwh, previewSetpoint } from "@/lib/domain";
import { PARAMETER_CONFIGS, type GridState, type IncentiveModel } from "@/lib/types";

/** Compose an alert by hand and push it down the ordinary path. */
export function TestAlertPanel({
  gridState,
  incentives,
  onClose,
  onSent,
}: {
  /** For the "currently over its line" readout, as in ThresholdPanel. */
  gridState: GridState | null;
  /** `GET /api/incentives` — the served shed and window tables. */
  incentives: IncentiveModel | null;
  onClose: () => void;
  /** Fired after a successful push, so the feed refetches. */
  onSent: () => void;
}) {
  const [parameter, setParameter] = useState("peak_load");
  const [severity, setSeverity] = useState("critical");
  const [windowMins, setWindowMins] = useState<number | null>(null);
  // null = untouched, so the backend derives it. A number here is an override.
  const [watts, setWatts] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The backend's own default for this severity, until the operator sets one.
  const defaultWindow = defaultWindowMinutes(incentives, severity) ?? 120;
  const effectiveWindow = windowMins ?? defaultWindow;

  const preview = previewSetpoint(incentives, parameter, severity, effectiveWindow);
  const effectiveWatts = watts ?? preview?.watts ?? null;
  // Overriding the setpoint restates the energy ask; show what it becomes.
  const effectiveShed =
    watts != null && effectiveWindow > 0
      ? Math.round(((watts * effectiveWindow) / 60_000) * 1000) / 1000
      : preview?.shedKwh ?? null;

  // Whether this parameter is actually over its line right now.
  const config = PARAMETER_CONFIGS.find((c) => c.parameter === parameter);
  const live =
    gridState && config ? Boolean(gridState.parameters[config.triggeredKey]) : null;

  async function send() {
    setSending(true);
    setError(null);
    const res = await apiPushTestAlert({
      parameter,
      severity,
      duration_minutes: effectiveWindow,
      // Only when overridden — an untouched form produces an alert arithmetically identical to a
      // triggered one.
      ...(watts != null ? { target_reduction_w: watts } : {}),
    });
    setSending(false);
    if (res.ok) {
      onSent();
      onClose();
    } else {
      setError(res.error);
    }
  }

  return (
    <div
      className="ds-sheet-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Send a test alert"
      // Click-outside closes, scrim only — same guard as ThresholdPanel, so a drag that ends
      // outside a field is not read as a dismissal.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ds-sheet-panel__body">
        <div className="ds-sheet-panel__head">
          <div>
            <h2 className="ds-header__title">Send a test alert</h2>
            <p className="ds-header__sub">
              Goes out through the gateway like any other alert. Households can
              answer it, and it counts.
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
          <div className="ds-field">
            <label className="ds-field__label" htmlFor="test-parameter">
              Alert type
            </label>
            <select
              id="test-parameter"
              className="ds-select"
              value={parameter}
              onChange={(e) => {
                setParameter(e.target.value);
                setWatts(null);
              }}
            >
              {PARAMETERS.filter(Boolean).map((p) => (
                <option key={p} value={p}>
                  {PARAMETER_LABELS[p] ?? p}
                </option>
              ))}
            </select>
          </div>

          <div className="ds-field">
            <label className="ds-field__label" htmlFor="test-severity">
              Severity
            </label>
            <select
              id="test-severity"
              className="ds-select"
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value);
                // Both defaults key off severity, so a change re-derives them.
                setWindowMins(null);
                setWatts(null);
              }}
            >
              {SEVERITIES.filter(Boolean).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <p className="ds-muted ds-muted--xs">
              Chosen, not derived — the gate is not asked whether it would have
              fired at this level.
            </p>
          </div>

          <div className="ds-field">
            <label className="ds-field__label" htmlFor="test-window">
              Window (minutes)
            </label>
            <input
              id="test-window"
              type="number"
              className="ds-input"
              min={1}
              max={720}
              value={effectiveWindow}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWindowMins(Number.isFinite(n) && n > 0 ? n : null);
                setWatts(null);
              }}
            />
            <p className="ds-muted ds-muted--xs">
              How long the household is asked to hold the reduction for.
              Default for {severity} is {defaultWindow} min.
            </p>
          </div>

          <div className="ds-field">
            <label className="ds-field__label" htmlFor="test-watts">
              Target power reduction (W)
            </label>
            <input
              id="test-watts"
              type="number"
              className="ds-input"
              min={0}
              step={50}
              value={effectiveWatts ?? ""}
              placeholder={preview ? String(preview.watts) : "derived from severity"}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setWatts(null);
                  return;
                }
                const n = Number(raw);
                setWatts(Number.isFinite(n) && n >= 0 ? n : null);
              }}
            />
            {/* The honest label on the number in the box: whose it is. */}
            <p className="ds-muted ds-muted--xs">
              {watts == null
                ? "Derived from the shed model, the same way a triggered alert's is. Clear the field to keep it that way."
                : "Overridden — the energy ask below is derived back from this, so it will differ from a real alert of this kind."}
            </p>
          </div>
        </div>

        {/* What the household will actually be asked for, before sending. */}
        <div className="ds-sheet">
          <div className="ds-sheet__row">
            <span className="ds-sheet__label">Asks for</span>
            <span className="ds-sheet__value">
              {effectiveShed != null && effectiveWatts != null
                ? `${kwh(effectiveShed)} kWh — about ${idr(effectiveWatts)} W for ${effectiveWindow} min`
                : "waiting for the incentive model…"}
            </span>
          </div>
          <div className="ds-sheet__row">
            <span className="ds-sheet__label">Right now</span>
            <span className="ds-sheet__value">
              {live === null
                ? "no reading yet"
                : live
                  ? "this parameter is over its threshold"
                  : "this parameter is not over its threshold"}
            </span>
          </div>
        </div>

        {live === false && (
          <Notice tone="pending">
            The alert quotes live readings, so its wording will describe a grid
            that is not actually in this state. That is honest rather than
            broken — but a price alert on a calm grid will report no saving.
          </Notice>
        )}

        <div className="ds-modal__actions">
          <button className="ds-btn" disabled={sending} onClick={onClose}>
            Cancel
          </button>
          <button
            className="ds-btn ds-btn--primary"
            disabled={sending || effectiveWatts == null}
            onClick={send}
          >
            {sending ? "Sending…" : "Send alert"}
          </button>
        </div>

        <p className="ds-muted ds-muted--xs">
          Recorded in the audit log. With no gateway attached it lands as
          &ldquo;not delivered&rdquo; and reaches nobody — which is worth
          testing too.
        </p>
      </div>
    </div>
  );
}
