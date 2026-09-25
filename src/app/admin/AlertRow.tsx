"use client";

import { throttleLine } from "@/lib/domain";
import type { DSMAlert, DSMResponse } from "@/lib/types";

/**
 * What has happened to an alert, from the dashboard's point of view.
 *
 * One map replaces the three parallel Sets the admin page used to carry
 * (pushed / ignored / undelivered), which could disagree with each other —
 * "failed" was being folded into "pushed", which is what removed the buttons
 * from an alert that had not actually been delivered.
 */
export type Outcome =
  | "pushed"
  | "failed-gateway" // backend accepted it but no ESP32 was attached
  | "failed-request" // the request itself never completed
  | "ignored"
  | "auto-pushed";

/**
 * The two failure kinds behave identically (the alert is undelivered and
 * keeps a Resend) but they are not the same event, and saying "esp32 down"
 * for a network error puts a false cause on screen next to a header badge
 * reading "ESP32 Up".
 */
export const isFailed = (o: Outcome | null) =>
  o === "failed-gateway" || o === "failed-request";

/**
 * Composite identity of an alert.
 *
 * `id` is a fresh `uuid4()[:8]` per trigger, so it is already unique — the tick
 * is here because `(alert_id, tick)` is the unique constraint on the `alerts`
 * table, and matching it keeps the client's notion of "same alert" identical to
 * the database's. Live socket responses key on `alert_id` alone, because that
 * is all the `dsm_response` payload carries; the two agree precisely because
 * the id is unique on its own.
 */
export const keyOf = (alert: DSMAlert) => alert.id + alert.tick;

/**
 * One row of the alert feed.
 *
 * `outcome === "failed"` is deliberately *not* terminal — the alert was never
 * delivered, so the row keeps an action. Previously a failed push was folded in
 * with a successful one, which removed the buttons and left the alert stranded.
 */
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

  // Say what actually went wrong. A gateway outage and a failed request are
  // both "undelivered" but they call for different things from the operator.
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
          {outcome === "auto-pushed" && <span className="ds-tag ds-tag--auto">auto-pushed</span>}
          {outcome === "pushed" && <span className="ds-tag ds-tag--ok">delivered to gateway</span>}
          {failed && <span className="ds-tag ds-tag--bad">{failureText}</span>}
          {outcome === "ignored" && <span className="ds-tag">ignored</span>}
          {/* What this alert is asking for, in the operator's own units. The
              feed showed a severity and a message but never the size of the
              ask, so "push this one" was a judgement with the magnitude left
              out. */}
          {alert.expected_shed_kwh ? (
            <span
              className="ds-tag"
              title="Modelled load reduction per household that accepts, by parameter and severity"
            >
              {alert.expected_shed_kwh.toFixed(2)} kWh ask
            </span>
          ) : null}
          {/* The same ask as the setpoint a load controller would hold. Null on
              alerts written before the throttle model. */}
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
                // The names, on hover. They belong here rather than as more
                // chips because the counts are what the operator scans for and
                // a row of usernames would bury them.
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
