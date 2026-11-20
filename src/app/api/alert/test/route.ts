import { z } from "zod";
import type { Parameter, Severity } from "@/lib/types";
import { markPushed, recordTrigger } from "@/server/alerts/store";
import { recordAudit } from "@/server/audit";
import { AUDIT } from "@/server/db/schema";
import { PARAMETERS, SEVERITIES } from "@/server/grid/constants";
import { shedFromSetpoint, throttleWindowMinutes } from "@/server/grid/incentives";
import { ApiError, clientIp, json, readBody, requireAdmin, route } from "@/server/http";

// The operator picks what kind of alert and how hard; the server builds the rest from the live
// grid.
const Body = z.object({
  parameter: z.string(),
  severity: z.string(),
  duration_minutes: z.number().int().nullish(),
  target_reduction_w: z.number().nullish(),
});

/** Compose an alert by hand and push it down the ordinary path. */
export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  const body = await readBody(req, Body);
  if (!(PARAMETERS as string[]).includes(body.parameter)) {
    throw new ApiError(400, "bad_request", `Unknown parameter: ${body.parameter}`);
  }
  if (!(SEVERITIES as string[]).includes(body.severity)) {
    throw new ApiError(400, "bad_request", `Unknown severity: ${body.severity}`);
  }

  const state = rt.simulator.currentGridState();
  if (!state) throw new ApiError(409, "no_dataset", "No dataset loaded — the server has no grid to describe");

  const window = body.duration_minutes || throttleWindowMinutes(body.severity);
  if (window <= 0) throw new ApiError(400, "bad_request", "duration_minutes must be positive");

  // Only when the operator typed over the pre-filled watts; otherwise the shed comes from the model
  // exactly as a real alert's does.
  const shedOverride = body.target_reduction_w != null ? shedFromSetpoint(body.target_reduction_w, window) : undefined;

  const alert = rt.simulator.control.compose(state, body.parameter as Parameter, body.severity as Severity, {
    durationMinutes: window,
    shedOverride,
  });
  const connected = rt.hub.gatewayConnected;

  recordTrigger(rt.db, alert);
  markPushed(rt.db, alert, admin.id, false, connected);
  recordAudit(rt.db, AUDIT.ALERT_PUSH, {
    actor: admin,
    targetType: "alert",
    targetId: alert.id,
    targetLabel: alert.title,
    // Same action as an ordinary push; `composed` keeps it recoverable.
    detail: {
      severity: alert.severity,
      tick: alert.tick,
      esp32_connected: connected,
      composed: true,
      duration_minutes: alert.duration_minutes,
      target_reduction_w: alert.target_reduction_w,
    },
    ip: clientIp(req),
  });
  rt.hub.relayAlertToGateway(alert);
  return json({
    message: connected ? "Alert relayed to ESP32 gateway" : "No ESP32 gateway connected — alert was not delivered",
    esp32_connected: connected,
    alert,
  });
});
