import { and, desc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { DELIVERY_GRACE_MS } from "@/lib/constants";
import { alerts } from "@/server/db/schema";
import { responsesFor } from "@/server/history";
import { json, qLimit, qOffset, readQuery, requireAdmin, route } from "@/server/http";
import { alertItem, usernames } from "@/server/serialize";

const Query = z.object({
  limit: qLimit(100, 500),
  offset: qOffset,
  severity: z.string().optional(),
  parameter: z.string().optional(),
  outcome: z.enum(["pending", "ignored", "delivered", "sending", "failed"]).optional(),
});

/** Every triggered alert, newest first: pushed, dropped, ignored or still pending. */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const q = readQuery(req, Query);

  // `outcome` is derived, so it is expressed with the same predicates as alertOutcome().
  const graceStart = new Date(Date.now() - DELIVERY_GRACE_MS);
  const undelivered = and(isNotNull(alerts.pushedAt), isNull(alerts.deliveredAt), isNull(alerts.ignoredAt));
  const outcome = {
    pending: and(isNull(alerts.pushedAt), isNull(alerts.ignoredAt)),
    ignored: isNotNull(alerts.ignoredAt),
    delivered: and(isNotNull(alerts.deliveredAt), isNull(alerts.ignoredAt)),
    sending: and(undelivered, eq(alerts.pushRelayed, true), gte(alerts.pushedAt, graceStart)),
    failed: and(undelivered, or(eq(alerts.pushRelayed, false), lt(alerts.pushedAt, graceStart))),
  };

  const rows = rt.db
    .select()
    .from(alerts)
    .where(
      and(
        isNull(alerts.clearedAt),
        q.severity ? eq(alerts.severity, q.severity) : undefined,
        q.parameter ? eq(alerts.parameter, q.parameter) : undefined,
        q.outcome ? outcome[q.outcome] : undefined,
      ),
    )
    .orderBy(desc(alerts.triggeredAt), desc(alerts.tick))
    .limit(q.limit)
    .offset(q.offset)
    .all();

  const responses = responsesFor(rt.db, rows);
  const pushers = usernames(rt.db, rows.map((a) => a.pushedBy));
  return json(
    rows.map((a) =>
      alertItem(a, responses.get(a.id) ?? [], { pushedByUsername: a.pushedBy ? (pushers.get(a.pushedBy) ?? null) : null }),
    ),
  );
});
