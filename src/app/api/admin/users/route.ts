import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { STATUS_PENDING, users } from "@/server/db/schema";
import { json, readQuery, requireAdmin, route } from "@/server/http";
import { userOut, usernames } from "@/server/serialize";

const Query = z.object({ status: z.string().optional() });

/** All accounts, pending first: the approval queue is why the operator opened this. */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const { status } = readQuery(req, Query);
  const rows = rt.db
    .select()
    .from(users)
    .where(status ? eq(users.status, status) : undefined)
    .orderBy(sql`${users.status} != ${STATUS_PENDING}`, desc(users.createdAt))
    .all();
  const approvers = usernames(rt.db, rows.map((u) => u.approvedBy));
  return json(rows.map((u) => userOut(u, u.approvedBy ? (approvers.get(u.approvedBy) ?? null) : null)));
});
