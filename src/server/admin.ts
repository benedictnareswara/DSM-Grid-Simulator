/**
 * Guards for account management. An admin can't act on their own account, and
 * the last active admin can't be removed. Locking yourself out of a local demo
 * should be impossible, not something the docs explain how to undo.
 */

import { and, count, eq, ne } from "drizzle-orm";
import type { Conn } from "./db/client";
import { ROLE_ADMIN, STATUS_ACTIVE, users, type UserRow } from "./db/schema";
import { ApiError } from "./http";
import { usernames } from "./serialize";

export type IdParams = { params: Promise<{ id: string }> };

export function loadTarget(db: Conn, id: string): UserRow {
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw new ApiError(404, "no_such_user", "No such account.");
  return user;
}

export function guardNotSelf(target: UserRow, admin: UserRow): void {
  if (target.id === admin.id) {
    throw new ApiError(400, "cannot_act_on_self", "You cannot suspend or delete the account you are signed in with.");
  }
}

export function guardNotLastAdmin(db: Conn, target: UserRow): void {
  if (target.role !== ROLE_ADMIN || target.status !== STATUS_ACTIVE) return;
  const [{ n }] = db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, ROLE_ADMIN), eq(users.status, STATUS_ACTIVE), ne(users.id, target.id)))
    .all();
  if (!n) {
    throw new ApiError(400, "last_admin", "This is the only active operator account. Promote another before removing it.");
  }
}

export function approverName(db: Conn, user: UserRow): string | null {
  return user.approvedBy ? (usernames(db, [user.approvedBy]).get(user.approvedBy) ?? null) : null;
}
