import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { auditLog } from "@/server/db/schema";
import { json, qLimit, qOffset, readQuery, requireAdmin, route } from "@/server/http";
import { auditEntry } from "@/server/serialize";

const Query = z.object({
  limit: qLimit(100, 500),
  offset: qOffset,
  action: z.string().optional(),
  target_id: z.string().optional(),
});

/** A page of the audit trail, newest first. Cleared entries are hidden, not gone. */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const q = readQuery(req, Query);
  const rows = rt.db
    .select()
    .from(auditLog)
    .where(
      and(
        isNull(auditLog.clearedAt),
        q.action ? eq(auditLog.action, q.action) : undefined,
        q.target_id ? eq(auditLog.targetId, q.target_id) : undefined,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(q.limit)
    .offset(q.offset)
    .all();
  return json(rows.map(auditEntry));
});
