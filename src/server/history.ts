/** Reading persisted alerts and answers. */

import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { ParticipationEntry, ResponseSummary } from "@/lib/types";
import { z } from "zod";
import type { Conn } from "./db/client";
import { alertResponses, alerts, users, type AlertResponseRow, type AlertRow } from "./db/schema";
import { qBool } from "./http";
import { iso, participationEntry, usernames } from "./serialize";

/** Response summaries for a page of alerts, grouped by alert row id. */
export function responsesFor(db: Conn, alertRows: AlertRow[]): Map<string, ResponseSummary[]> {
  const out = new Map<string, ResponseSummary[]>();
  if (!alertRows.length) return out;
  const rows = db
    .select({ r: alertResponses, username: users.username })
    .from(alertResponses)
    .leftJoin(users, eq(users.id, alertResponses.userId))
    .where(inArray(alertResponses.alertId, alertRows.map((a) => a.id)))
    .all();
  for (const { r, username } of rows) {
    const list = out.get(r.alertId) ?? [];
    list.push({
      user_id: r.userId,
      username: username ?? "(deleted)",
      accepted: r.accepted,
      responded_at: iso(r.respondedAt)!,
    });
    out.set(r.alertId, list);
  }
  return out;
}

export const ParticipationQuery = z.object({
  user_id: z.string().optional(),
  accepted: qBool.optional(),
  severity: z.string().optional(),
  parameter: z.string().optional(),
});

/** Filters shared by the participation list and its count, so the pager can't disagree with the page. */
export function participationWhere(f: {
  user_id?: string;
  accepted?: boolean;
  severity?: string;
  parameter?: string;
}): SQL | undefined {
  return and(
    isNull(alerts.clearedAt),
    f.user_id ? eq(alertResponses.userId, f.user_id) : undefined,
    f.accepted !== undefined ? eq(alertResponses.accepted, f.accepted) : undefined,
    f.severity ? eq(alerts.severity, f.severity) : undefined,
    f.parameter ? eq(alerts.parameter, f.parameter) : undefined,
  );
}

/** Answers joined to their alerts and usernames, newest first. */
export function participationRows(
  db: Conn,
  where: SQL | undefined,
  limit?: number,
  offset = 0,
): { r: AlertResponseRow; a: AlertRow; username: string | null }[] {
  const q = db
    .select({ r: alertResponses, a: alerts, username: users.username })
    .from(alertResponses)
    .innerJoin(alerts, eq(alerts.id, alertResponses.alertId))
    .leftJoin(users, eq(users.id, alertResponses.userId))
    .where(where)
    .orderBy(desc(alertResponses.respondedAt))
    .$dynamic();
  if (limit !== undefined) q.limit(limit).offset(offset);
  return q.all();
}

export function toParticipation(
  db: Conn,
  rows: { r: AlertResponseRow; a: AlertRow; username: string | null }[],
): ParticipationEntry[] {
  const pushers = usernames(db, rows.map((x) => x.a.pushedBy));
  return rows.map(({ r, a, username }) =>
    participationEntry(r, a, username ?? undefined, a.pushedBy ? (pushers.get(a.pushedBy) ?? null) : null),
  );
}
