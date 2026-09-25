import { eq } from "drizzle-orm";
import { approverName, loadTarget, type IdParams } from "@/server/admin";
import { recordAudit } from "@/server/audit";
import { AUDIT, STATUS_ACTIVE, users } from "@/server/db/schema";
import { clientIp, json, requireAdmin, route } from "@/server/http";
import { userOut } from "@/server/serialize";

/** Undo a suspension. Suspend can be undone; delete can't. */
export const POST = route<IdParams>(async (req, { rt, params }) => {
  const admin = await requireAdmin(req, rt);
  const target = loadTarget(rt.db, (await params).id);

  const updated = rt.db.transaction((tx) => {
    const row = tx
      .update(users)
      .set({
        status: STATUS_ACTIVE,
        ...(target.approvedAt ? {} : { approvedAt: new Date(), approvedBy: admin.id }),
      })
      .where(eq(users.id, target.id))
      .returning()
      .get();
    recordAudit(tx, AUDIT.USER_REINSTATE, {
      actor: admin,
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      detail: { from: target.status },
      ip: clientIp(req),
    });
    return row;
  });
  rt.hub.broadcastAccountsChanged();
  console.log(`[ADMIN] ${admin.username} reinstated ${target.username}`);
  return json(userOut(updated, approverName(rt.db, updated)));
});
