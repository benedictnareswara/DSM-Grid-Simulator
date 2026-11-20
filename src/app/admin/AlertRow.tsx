"use client";

import { throttleLine } from "@/lib/domain";
import type { DSMAlert, DSMResponse } from "@/lib/types";

/** What has happened to an alert, from the dashboard's point of view. */
export type Outcome =
  | "sending" // handed to the gateway, waiting for its delivery echo
  | "pushed"
  | "failed-gateway" // backend accepted it but no ESP32 was attached
  | "failed-request" // the request itself never completed
  | "ignored"
  | "auto-pushed";

/**
 * The two failure kinds behave identically (the alert is undelivered and keeps a Resend) but they
 * are not the same event, and saying "esp32 down" for a network error puts a false cause on screen
 * next to a header badge reading "ESP32 Up".
 */
export const isFailed = (o: Outcome | null) =>
  o === "failed-gateway" || o === "failed-request";

/** Composite identity of an alert. */
export const keyOf = (alert: DSMAlert) => alert.id + alert.tick;

/** One row of the alert feed. */
export function AlertRow({
  alert,
  outcome,
  isPushing,
  esp32Connected,
  responses,
  onPush,
  onIgnore,
  onUndoIgnore,
}: {
  alert: DSMAlert;
  outcome: Outcome | null;
  isPushing: boolean;
  esp32Connected: boolean;
  responses: DSMResponse[];
  onPush: (alert: DSMAlert) => void;
  onIgnore: (alert: DSMAlert) => void;
  onUndoIgnore: (alert: DSMAlert) => void;
}) {
  const accepted = responses.filter((r) => r.accepted).length;
  const declined = responses.length - accepted;
  const failed = isFailed(outcome);
  const throttle = throttleLine(alert);

  // Say what actually went wrong.
  const failureText =
    outcome === "failed-request"
      ? "not delivered · request failed"
      : alert.auto_push_status === "esp32_offline" && outcome === "failed-gateway"
        ? "auto-push failed · esp32 down"
        : "not delivered · esp32 down";

  return (
    <div
      className={`ds-alert ds-alert--${alert.severity} ${outcome === "ignored" ? "ds-alert--dimmed" : ""}`}
    >
      <div className="ds-alert__strip">
        <span className="ds-alert__sev">{alert.severity}</span>
        <span className="ds-alert__time">{alert.timestamp}</span>
      </div>
      <div className="ds-alert__body">
        <div className="ds-alert__head">
          <div className="ds-flex-1">
            <div className="ds-alert__title">{alert.title}</div>
            <div className="ds-alert__msg">{alert.message}</div>
          </div>

          <div className="ds-alert__actions">
            {outcome === null && (
              <>
                <button
                  className="ds-btn ds-btn--primary ds-btn--sm"
                  onClick={() => onPush(alert)}
                  disabled={isPushing}
                >
                  {isPushing ? "Pushing…" : "Push"}
                </button>
                <button className="ds-btn ds-btn--sm" onClick={() => onIgnore(alert)}>
                  Ignore
                </button>
              </>
            )}
            {failed && (
              <button
                className="ds-btn ds-btn--primary ds-btn--sm"
                onClick={() => onPush(alert)}
                disabled={isPushing || !esp32Connected}
                title={
                  esp32Connected
                    ? "Push this alert to the gateway again"
                    : "The ESP32 gateway is offline — a resend would fail too"
                }
              >
                {isPushing ? "Resending…" : "Resend"}
              </button>
            )}
            {outcome === "ignored" && (
              <button className="ds-btn ds-btn--sm" onClick={() => onUndoIgnore(alert)}>
                Undo
              </button>
            )}
          </div>
        </div>

        <div className="ds-alert__tags">
          {outcome === "sending" && (
            <span className="ds-tag ds-tag--sending" title="Waiting for the gateway to confirm it forwarded this alert">
              sending via gateway…
            </span>
          )}
          {outcome === "auto-pushed" && <span className="ds-tag ds-tag--auto">auto-delivered</span>}
          {outcome === "pushed" && <span className="ds-tag ds-tag--ok">delivered</span>}
          {failed && <span className="ds-tag ds-tag--bad">{failureText}</span>}
          {outcome === "ignored" && <span className="ds-tag">ignored</span>}
          {/* What this alert is asking for, in the operator's own units. */}
          {alert.expected_shed_kwh ? (
            <span
              className="ds-tag"
              title="Modelled load reduction per household that accepts, by parameter and severity"
            >
              {alert.expected_shed_kwh.toFixed(2)} kWh ask
            </span>
          ) : null}
          {/* The same ask as the setpoint a load controller would hold. */}
          {throttle ? (
            <span
              className="ds-tag"
              title="The kWh ask expressed as a controller setpoint — what the upcoming throttle would hold"
            >
              {throttle}
            </span>
          ) : null}
          {responses.length > 0 && (
            <>
              <span
                className="ds-tag"
                // The names, on hover.
                title={responses
                  .map((r) => `${r.username || "(anonymous)"} — ${r.accepted ? "accepted" : "declined"}`)
                  .join("\n")}
              >
                {responses.length} {responses.length === 1 ? "response" : "responses"}
              </span>
              {accepted > 0 && <span className="ds-tag ds-tag--ok">{accepted} accepted</span>}
              {declined > 0 && <span className="ds-tag">{declined} declined</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
