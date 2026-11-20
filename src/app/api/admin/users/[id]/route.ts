import { eq } from "drizzle-orm";
import { approverName, guardNotLastAdmin, guardNotSelf, loadTarget, type IdParams } from "@/server/admin";
import { recordAudit } from "@/server/audit";
import { AUDIT, users } from "@/server/db/schema";
import { clientIp, json, requireAdmin, route } from "@/server/http";
import { userOut } from "@/server/serialize";

/** One account, with the name of whoever approved it. */
export const GET = route<IdParams>(async (req, { rt, params }) => {
  await requireAdmin(req, rt);
  const target = loadTarget(rt.db, (await params).id);
  return json(userOut(target, approverName(rt.db, target)));
});

/** Remove an account and everything hanging off it (sessions, responses). */
export const DELETE = route<IdParams>(async (req, { rt, params }) => {
  const admin = await requireAdmin(req, rt);
  const target = loadTarget(rt.db, (await params).id);
  guardNotSelf(target, admin);
  guardNotLastAdmin(rt.db, target);

  rt.db.transaction((tx) => {
    recordAudit(tx, AUDIT.USER_DELETE, {
      actor: admin,
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      detail: { role: target.role, status: target.status },
      ip: clientIp(req),
    });
    tx.delete(users).where(eq(users.id, target.id)).run();
  });
  rt.hub.disconnectUser(target.id);
  rt.hub.broadcastAccountsChanged();
  console.log(`[ADMIN] ${admin.username} deleted ${target.username}`);
  return json({ message: `Deleted ${target.username}.`, deleted_id: target.id });
});
