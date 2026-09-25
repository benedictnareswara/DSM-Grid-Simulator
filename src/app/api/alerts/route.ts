import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { alerts } from "@/server/db/schema";
import { responsesFor } from "@/server/history";
import { json, qLimit, qOffset, readQuery, requireAdmin, route } from "@/server/http";
import { alertItem, usernames } from "@/server/serialize";

const Query = z.object({
  limit: qLimit(100, 500),
  offset: qOffset,
  severity: z.string().optional(),
  parameter: z.string().optional(),
  outcome: z.enum(["pending", "ignored", "delivered", "failed"]).optional(),
});

/**
 * Every triggered alert, newest first: pushed, dropped, ignored or still
 * pending. No delivery filter, on purpose; see src/server/history.ts.
 */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const q = readQuery(req, Query);

  // `outcome` is derived, so it is expressed with the same predicates as alertOutcome().
  const outcome = {
    pending: and(isNull(alerts.pushedAt), isNull(alerts.ignoredAt)),
    ignored: isNotNull(alerts.ignoredAt),
    delivered: and(isNotNull(alerts.deliveredAt), isNull(alerts.ignoredAt)),
    failed: and(isNotNull(alerts.pushedAt), isNull(alerts.deliveredAt), isNull(alerts.ignoredAt)),
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
