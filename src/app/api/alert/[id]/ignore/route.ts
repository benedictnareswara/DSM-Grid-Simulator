import { z } from "zod";
import { markIgnored } from "@/server/alerts/store";
import { recordAudit } from "@/server/audit";
import { AUDIT } from "@/server/db/schema";
import { ApiError, clientIp, json, qBool, readQuery, requireAdmin, route } from "@/server/http";

const Query = z.object({
  tick: z.coerce.number().int().optional(),
  ignored: qBool.default(true),
});

/** Mark an alert ignored, or undo that. Doesn't touch the gateway: ignoring means not delivering. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { rt, params }) => {
  const admin = await requireAdmin(req, rt);
  const { id } = await params;
  const { tick, ignored } = readQuery(req, Query);
  if (!markIgnored(rt.db, id, tick ?? null, admin.id, ignored)) {
    throw new ApiError(404, "no_such_alert", "That alert is not in the history.");
  }
  recordAudit(rt.db, ignored ? AUDIT.ALERT_IGNORE : AUDIT.ALERT_UNIGNORE, {
    actor: admin,
    targetType: "alert",
    targetId: id,
    targetLabel: tick !== undefined ? `${id}@${tick}` : id,
    ip: clientIp(req),
  });
  return json({ alert_id: id, ignored });
});
