import { clearHistory } from "@/server/alerts/store";
import { recordAudit } from "@/server/audit";
import { AUDIT } from "@/server/db/schema";
import { clientIp, requireAdmin, route } from "@/server/http";
import { statusResponse } from "@/server/sim-control";

/**
 * Reset the run and clear every dashboard's feed. History is hidden, not
 * deleted, so a reload doesn't bring the feed back and a mid-demo reset
 * doesn't destroy the record.
 */
export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  const tickAtReset = rt.simulator.currentTick;
  rt.simulator.reset();
  clearHistory(rt.db);
  recordAudit(rt.db, AUDIT.SIM_RESET, {
    actor: admin,
    targetType: "simulation",
    detail: { tick_at_reset: tickAtReset },
    ip: clientIp(req),
  });
  rt.hub.broadcastSystemReset();
  return statusResponse(rt, "Simulation reset — all feeds cleared");
});
