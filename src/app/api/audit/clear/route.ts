import { isNull } from "drizzle-orm";
import { recordAudit } from "@/server/audit";
import { AUDIT, auditLog } from "@/server/db/schema";
import { clientIp, json, requireAdmin, route } from "@/server/http";

/** Empty the operator's view of the audit log. */
export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  const now = new Date();
  const { changes } = rt.db.update(auditLog).set({ clearedAt: now }).where(isNull(auditLog.clearedAt)).run();
  recordAudit(rt.db, AUDIT.AUDIT_CLEAR, {
    actor: admin,
    targetType: "audit_log",
    targetLabel: `${changes} entries`,
    detail: { hidden: changes, cleared_at: now.toISOString() },
    ip: clientIp(req),
  });
  return json({ message: `${changes} entries hidden.`, hidden: changes });
});
