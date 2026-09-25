"use client";

/** Reset is the one irreversible control on the dashboard, so it names what it destroys. */
export function ResetConfirm({
  tick,
  alertCount,
  responseCount,
  consumerCount,
  onConfirm,
  onCancel,
}: {
  tick: number;
  alertCount: number;
  responseCount: number;
  consumerCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="ds-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-title"
      onClick={onCancel}
    >
      <div className="ds-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal__title" id="reset-title">
          Reset the simulation?
        </div>
        <div className="ds-modal__body">
          This rewinds to <strong>tick 0</strong> from tick{" "}
          <strong>{tick.toLocaleString()}</strong>, clears the alert cooldowns, and empties
          every feed — <strong>{alertCount}</strong>{" "}
          {alertCount === 1 ? "alert" : "alerts"} and <strong>{responseCount}</strong>{" "}
          {responseCount === 1 ? "response" : "responses"} here, plus the alert history on{" "}
          <strong>
            {consumerCount} connected {consumerCount === 1 ? "phone" : "phones"}
          </strong>
          . The savings totals go with them.
        </div>
        <div className="ds-modal__actions">
          <button className="ds-btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="ds-btn ds-btn--danger" onClick={onConfirm}>
            Reset everything
          </button>
        </div>
      </div>
    </div>
  );
}
