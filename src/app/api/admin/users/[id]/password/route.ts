import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadTarget, type IdParams } from "@/server/admin";
import { recordAudit } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { revokeAllForUser } from "@/server/auth/tokens";
import { AUDIT, users } from "@/server/db/schema";
import { clientIp, json, readBody, requireAdmin, route } from "@/server/http";

const Body = z.object({ password: z.string().min(8).max(72) });

/**
 * Set a household's password. Hashes are one-way, so the only useful ability
 * is replacing a password, never reading one. Every existing session is signed
 * out, and the password never appears in a response or the audit log.
 */
export const POST = route<IdParams>(async (req, { rt, params }) => {
  const admin = await requireAdmin(req, rt);
  const target = loadTarget(rt.db, (await params).id);
  const { password } = await readBody(req, Body);
  const passwordHash = await hashPassword(password);

  rt.db.transaction((tx) => {
    tx.update(users).set({ passwordHash }).where(eq(users.id, target.id)).run();
    revokeAllForUser(tx, target.id);
    recordAudit(tx, AUDIT.USER_PASSWORD, {
      actor: admin,
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      detail: { self: target.id === admin.id },
      ip: clientIp(req),
    });
  });
  rt.hub.disconnectUser(target.id);
  console.log(`[ADMIN] ${admin.username} reset the password for ${target.username}`);
  return json({ message: `Password updated for ${target.username}. Their sessions were signed out.` });
});
