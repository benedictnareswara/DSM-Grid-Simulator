import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { AUDIT } from "@/server/db/schema";
import { clientIp, json, qBool, readQuery, requireConsumer, route } from "@/server/http";

const Query = z.object({ accepted: qBool });

/** A household accepts or declines, routed through the gateway. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { rt, params }) => {
  const user = await requireConsumer(req, rt);
  const { id } = await params;
  const { accepted } = readQuery(req, Query);
  const connected = rt.hub.gatewayConnected;

  recordAudit(rt.db, AUDIT.ALERT_RESPOND, {
    actor: user,
    targetType: "alert",
    targetId: id,
    targetLabel: id,
    detail: { accepted, esp32_connected: connected },
    ip: clientIp(req),
  });
  rt.hub.relayResponseToGateway({
    alert_id: id,
    accepted,
    // Zone-aware UTC: the gateway echoes this string back verbatim.
    responded_at: new Date().toISOString(),
    user_id: user.id,
    username: user.username,
  });
  return json({
    message: connected ? "Response relayed to ESP32 gateway" : "No ESP32 gateway connected — response was not delivered",
    alert_id: id,
    accepted,
    esp32_connected: connected,
  });
});
