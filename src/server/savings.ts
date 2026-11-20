/** What the programme is estimated to have saved. */

import { and, count, eq, isNotNull, isNull, sum } from "drizzle-orm";
import type { SavingsBucket, SavingsPoint, SavingsSummary } from "@/lib/types";
import type { Conn } from "./db/client";
import { alertResponses, alerts, type AlertResponseRow, type AlertRow } from "./db/schema";
import * as incentives from "./grid/incentives";
import { pyRound } from "./grid/pyround";
import { participationRows } from "./history";

// A cumulative chart doesn't need 40,000 points to show a line going up.
const MAX_SERIES_POINTS = 200;

type Accepted = { r: AlertResponseRow; a: AlertRow; kwh: number; credit: number };

function bucket(rows: Accepted[], key: (a: AlertRow) => string): SavingsBucket[] {
  const totals = new Map<string, { responses: number; kwh: number; credit: number }>();
  for (const { a, kwh, credit } of rows) {
    const slot = totals.get(key(a)) ?? { responses: 0, kwh: 0, credit: 0 };
    slot.responses += 1;
    slot.kwh += kwh;
    slot.credit += credit;
    totals.set(key(a), slot);
  }
  return [...totals.entries()]
    .map(([k, v]) => ({ key: k, responses: v.responses, kwh: pyRound(v.kwh, 3), credit_idr: pyRound(v.credit, 2) }))
    .sort((x, y) => y.kwh - x.kwh);
}

/** Running totals, oldest first. Thinned, but the last point (the total) is always kept. */
function series(rows: Accepted[]): SavingsPoint[] {
  const ordered = [...rows].sort((x, y) => x.r.respondedAt.getTime() - y.r.respondedAt.getTime());
  let kwh = 0;
  let credit = 0;
  const points = ordered.map(({ r, a, kwh: k, credit: c }) => {
    kwh += k;
    credit += c;
    return { tick: a.tick, responded_at: r.respondedAt.toISOString(), kwh: pyRound(kwh, 3), credit_idr: pyRound(credit, 2) };
  });
  if (points.length <= MAX_SERIES_POINTS) return points;
  const step = Math.floor(points.length / MAX_SERIES_POINTS) + 1;
  const thinned = points.filter((_, i) => i % step === 0);
  if (thinned[thinned.length - 1] !== points[points.length - 1]) thinned.push(points[points.length - 1]);
  return thinned;
}

export function summarise(db: Conn, userId: string | null): SavingsSummary {
  const householdView = userId !== null;
  const rows = participationRows(
    db,
    and(
      isNull(alerts.clearedAt),
      householdView ? eq(alertResponses.userId, userId) : undefined,
      householdView ? isNotNull(alerts.deliveredAt) : undefined, // ← the gateway gate.
    ),
  );

  // What this household was asked for, answered or not: every delivered alert.
  let offeredKwh = 0;
  let offeredAlerts = 0;
  if (householdView) {
    const [o] = db
      .select({ kwh: sum(alerts.expectedShedKwh), n: count(alerts.id) })
      .from(alerts)
      .where(and(isNull(alerts.clearedAt), isNotNull(alerts.deliveredAt)))
      .all();
    offeredKwh = Number(o.kwh ?? 0);
    offeredAlerts = o.n;
  }

  // The current run, read from the stored snapshot the credit was paid on.
  let currentStreak = 0;
  if (householdView && rows.length) {
    const newest = rows.reduce((m, x) => (x.r.respondedAt > m.r.respondedAt ? x : m));
    currentStreak = newest.r.accepted ? (newest.r.streakAtResponse ?? 0) : 0;
  }

  const accepted: Accepted[] = [];
  let declined = 0;
  for (const { r, a } of rows) {
    if (!r.accepted) {
      declined++;
      continue;
    }
    const latency = incentives.latencySeconds(a.deliveredAt, r.respondedAt);
    const kwh = a.expectedShedKwh ?? 0;
    const credit = incentives.creditIdr(a.rewardIdrPerKwh, kwh, latency, r.streakAtResponse ?? 0);
    accepted.push({ r, a, kwh, credit });
  }

  return {
    accepted_count: accepted.length,
    declined_count: declined,
    households: new Set(rows.map((x) => x.r.userId)).size,
    total_kwh: pyRound(accepted.reduce((s, x) => s + x.kwh, 0), 3),
    total_credit_idr: pyRound(accepted.reduce((s, x) => s + x.credit, 0), 2),
    offered_kwh: pyRound(offeredKwh, 3),
    offered_alerts: offeredAlerts,
    current_streak: currentStreak,
    streak_multiplier: incentives.streakMultiplier(currentStreak),
    by_severity: bucket(accepted, (a) => a.severity),
    by_parameter: bucket(accepted, (a) => a.parameter),
    series: series(accepted),
  };
}
