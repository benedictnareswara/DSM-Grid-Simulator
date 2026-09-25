import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "@/server/auth/password";
import { recordAudit } from "@/server/audit";
import { AUDIT, ROLE_CONSUMER, STATUS_PENDING, users } from "@/server/db/schema";
import { ApiError, clientIp, json, readBody, route, throttleCheck, throttleRecord } from "@/server/http";
import { userOut } from "@/server/serialize";

const USERNAME_RE = /^[a-z0-9._-]+$/;

// No `role` field on purpose: registration always makes a pending household.
const Body = z.object({
  username: z.string().min(3).max(64),
  email: z.email(),
  password: z.string().min(8).max(72),
});

/** Create a pending household account. Returns no tokens: an operator has to approve it first. */
export const POST = route(async (req, { rt }) => {
  const body = await readBody(req, Body);
  const username = body.username.trim().toLowerCase();
  throttleCheck(rt, req, username);

  if (!USERNAME_RE.test(username)) {
    throw new ApiError(400, "bad_username", "Username may use lowercase letters, digits, dot, dash and underscore only.");
  }
  const email = body.email.trim().toLowerCase();

  const clash = rt.db.select().from(users).where(or(eq(users.username, username), eq(users.email, email))).get();
  if (clash) {
    throttleRecord(rt, req, username);
    throw new ApiError(409, "already_registered", "That username or email is already registered.");
  }

  const passwordHash = await hashPassword(body.password);
  let user;
  try {
    user = rt.db
      .insert(users)
      .values({ username, email, passwordHash, role: ROLE_CONSUMER, status: STATUS_PENDING })
      .returning()
      .get();
  } catch {
    // Lost a race with a concurrent signup: the unique index is the real guard.
    throw new ApiError(409, "already_registered", "That username or email is already registered.");
  }

  recordAudit(rt.db, AUDIT.USER_REGISTER, {
    targetType: "user",
    targetId: user.id,
    targetLabel: username,
    detail: { email },
    ip: clientIp(req),
  });
  // Put the new signup in front of any open admin dashboard straight away.
  rt.hub.broadcastAccountsChanged();
  console.log(`[AUTH] Registered pending consumer: ${username}`);
  return json(
    { message: "Account created. An operator must approve it before you can sign in.", user: userOut(user) },
    201,
  );
});
