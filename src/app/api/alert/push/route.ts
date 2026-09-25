import { z } from "zod";
import type { DSMAlert } from "@/lib/types";
import { markPushed } from "@/server/alerts/store";
import { recordAudit } from "@/server/audit";
import { AUDIT } from "@/server/db/schema";
import { clientIp, json, readBody, requireAdmin, route } from "@/server/http";

const Body = z
  .object({
    id: z.string(),
    tick: z.number().int(),
    timestamp: z.string(),
    severity: z.enum(["info", "warning", "critical", "emergency"]),
    parameter: z.string(),
    title: z.string(),
    message: z.string(),
    value: z.number(),
    threshold: z.number(),
  })
  .loose();

/**
 * The operator pushes an alert through the gateway. This stamps pushed_at and
 * bumps push_attempts (a Resend is a retry). Only the gateway's echo marks it
 * delivered, so a push into a dead gateway leaves an "attempted, never
 * delivered" row, which is the state the operator most needs a record of.
 */
export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  const alert = (await readBody(req, Body)) as DSMAlert;
  const connected = rt.hub.gatewayConnected;

  markPushed(rt.db, alert, admin.id, false);
  recordAudit(rt.db, AUDIT.ALERT_PUSH, {
    actor: admin,
    targetType: "alert",
    targetId: alert.id,
    targetLabel: alert.title,
    detail: { severity: alert.severity, tick: alert.tick, esp32_connected: connected },
    ip: clientIp(req),
  });
  rt.hub.relayAlertToGateway(alert);
  return json({
    message: connected ? "Alert relayed to ESP32 gateway" : "No ESP32 gateway connected — alert was not delivered",
    esp32_connected: connected,
  });
});
