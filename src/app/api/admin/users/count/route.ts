import { count, eq } from "drizzle-orm";
import { STATUS_PENDING, users } from "@/server/db/schema";
import { json, requireAdmin, route } from "@/server/http";

/** Account totals for the dashboard tile. */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const [{ total }] = rt.db.select({ total: count() }).from(users).all();
  const [{ pending }] = rt.db.select({ pending: count() }).from(users).where(eq(users.status, STATUS_PENDING)).all();
  return json({ total, pending });
});
