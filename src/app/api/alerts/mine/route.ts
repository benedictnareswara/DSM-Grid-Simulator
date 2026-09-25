import { and, desc, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { alertResponses, alerts } from "@/server/db/schema";
import { json, qLimit, readQuery, requireConsumer, route } from "@/server/http";
import { alertItem } from "@/server/serialize";

const Query = z.object({ limit: qLimit(100, 500) });

/** This household's feed, restored after a reload. Delivered alerts only. */
export const GET = route(async (req, { rt }) => {
  const user = await requireConsumer(req, rt);
  const { limit } = readQuery(req, Query);
  const rows = rt.db
    .select()
    .from(alerts)
    .where(and(isNull(alerts.clearedAt), isNotNull(alerts.deliveredAt))) // ← the gateway gate. Do not remove.
    .orderBy(desc(alerts.deliveredAt))
    .limit(limit)
    .all();

  const mine = new Map<string, boolean>();
  if (rows.length) {
    const answers = rt.db
      .select()
      .from(alertResponses)
      .where(inArray(alertResponses.alertId, rows.map((a) => a.id)))
      .all();
    for (const r of answers) if (r.userId === user.id) mine.set(r.alertId, r.accepted);
  }
  return json(rows.map((a) => alertItem(a, [], { myResponse: mine.get(a.id) ?? null })));
});
