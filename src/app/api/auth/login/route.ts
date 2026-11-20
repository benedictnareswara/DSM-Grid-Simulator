import { eq } from "drizzle-orm";
import { z } from "zod";
import { verifyPassword } from "@/server/auth/password";
import { tokensFor } from "@/server/auth/session";
import { issueRefreshToken } from "@/server/auth/tokens";
import { recordAudit } from "@/server/audit";
import { AUDIT, STATUS_ACTIVE, STATUS_PENDING, users } from "@/server/db/schema";
import { ApiError, clientIp, json, readBody, route, throttleCheck, throttleClear, throttleRecord } from "@/server/http";

const Body = z.object({ username: z.string(), password: z.string() });

/** Exchange credentials for an access/refresh pair. */
export const POST = route(async (req, { rt }) => {
  const body = await readBody(req, Body);
  const username = body.username.trim().toLowerCase();
  throttleCheck(rt, req, username);

  const user = rt.db.select().from(users).where(eq(users.username, username)).get();
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throttleRecord(rt, req, username);
    throw new ApiError(401, "bad_credentials", "Wrong username or password.");
  }

  // Once the password checks out, saying *why* they can't get in leaks nothing.
  if (user.status === STATUS_PENDING) {
    throw new ApiError(403, "account_pending", "Your account is waiting for operator approval.");
  }
  if (user.status !== STATUS_ACTIVE) {
    throw new ApiError(403, "account_suspended", "Your account has been suspended.");
  }

  throttleClear(rt, req, username);
  // One transaction for the login stamp, its audit entry and the new session.
  const { updated, refresh } = rt.db.transaction((tx) => {
    const updated = tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)).returning().get();
    recordAudit(tx, AUDIT.USER_LOGIN, {
      actor: user,
      targetType: "user",
      targetId: user.id,
      targetLabel: user.username,
      detail: { role: user.role },
      ip: clientIp(req),
    });
    return { updated, refresh: issueRefreshToken(tx, updated) };
  });
  const tokens = await tokensFor(rt.db, updated, refresh);
  console.log(`[AUTH] Login: ${username} (${user.role})`);
  return json(tokens);
});
