import { count, eq } from "drizzle-orm";
import { alertResponses, alerts } from "@/server/db/schema";
import { ParticipationQuery, participationWhere } from "@/server/history";
import { json, readQuery, requireAdmin, route } from "@/server/http";

export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const q = readQuery(req, ParticipationQuery);
  const [{ total }] = rt.db
    .select({ total: count() })
    .from(alertResponses)
    .innerJoin(alerts, eq(alerts.id, alertResponses.alertId))
    .where(participationWhere(q))
    .all();
  return json({ total });
});
