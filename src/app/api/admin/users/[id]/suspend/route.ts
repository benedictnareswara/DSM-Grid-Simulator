import { eq } from "drizzle-orm";
import { approverName, guardNotLastAdmin, guardNotSelf, loadTarget, type IdParams } from "@/server/admin";
import { recordAudit } from "@/server/audit";
import { revokeAllForUser } from "@/server/auth/tokens";
import { AUDIT, STATUS_SUSPENDED, users } from "@/server/db/schema";
import { clientIp, json, requireAdmin, route } from "@/server/http";
import { userOut } from "@/server/serialize";

/**
 * Suspend an account. Revoking its refresh tokens stops it getting new access
 * tokens; closing its sockets stops the token it already holds from streaming.
 * Both are needed.
 */
export const POST = route<IdParams>(async (req, { rt, params }) => {
  const admin = await requireAdmin(req, rt);
  const target = loadTarget(rt.db, (await params).id);
  guardNotSelf(target, admin);
  guardNotLastAdmin(rt.db, target);

  const updated = rt.db.transaction((tx) => {
    const row = tx.update(users).set({ status: STATUS_SUSPENDED }).where(eq(users.id, target.id)).returning().get();
    revokeAllForUser(tx, target.id);
    recordAudit(tx, AUDIT.USER_SUSPEND, {
      actor: admin,
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      detail: { from: target.status },
      ip: clientIp(req),
    });
    return row;
  });
  rt.hub.disconnectUser(target.id);
  rt.hub.broadcastAccountsChanged();
  console.log(`[ADMIN] ${admin.username} suspended ${target.username}`);
  return json(userOut(updated, approverName(rt.db, updated)));
});
