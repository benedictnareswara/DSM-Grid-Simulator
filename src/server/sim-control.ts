import type { UserRow } from "./db/schema";
import { AUDIT } from "./db/schema";
import { recordAudit } from "./audit";
import { clientIp, json } from "./http";
import type { Runtime } from "./runtime";

/**
 * Respond to a run-control action and push the new status to every open
 * dashboard, so a second admin tab doesn't keep showing stale buttons. It's
 * also the one place run-state changes are audited.
 */
export function statusResponse(
  rt: Runtime,
  message: string,
  audit?: { action: string; admin: UserRow; req: Request },
): Response {
  const status = rt.simulator.getStatus();
  if (audit) {
    recordAudit(rt.db, AUDIT.SIM_CONTROL, {
      actor: audit.admin,
      targetType: "simulation",
      targetLabel: audit.action,
      detail: { action: audit.action, phase: status.phase, tick: status.current_tick, result: message },
      ip: clientIp(audit.req),
    });
  }
  rt.hub.broadcastStatus(status);
  return json({ message, status });
}
