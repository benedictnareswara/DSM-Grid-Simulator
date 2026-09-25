import { count, isNull } from "drizzle-orm";
import { auditLog } from "@/server/db/schema";
import { json, requireAdmin, route } from "@/server/http";

export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const [{ total }] = rt.db.select({ total: count() }).from(auditLog).where(isNull(auditLog.clearedAt)).all();
  return json({ total });
});
