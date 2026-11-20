/** Writing alerts and responses. */

import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { DSMAlert } from "@/lib/types";
import type { Conn, DB } from "../db/client";
import { alertResponses, alerts, type AlertRow } from "../db/schema";

// Enough to cover the streak multiplier's cap with room to spare.
const STREAK_LOOKBACK = 50;

type AlertLike = Partial<DSMAlert> & { id?: string };

/** Parse a timestamp that came back through the gateway. */
function parseIso(value: string | null | undefined): Date {
  if (!value) return new Date();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const d = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function alertColumns(a: AlertLike) {
  return {
    alertId: String(a.id ?? "").slice(0, 64),
    tick: Math.trunc(Number(a.tick ?? 0)),
    timestamp: String(a.timestamp ?? "").slice(0, 64),
    severity: String(a.severity ?? "info").slice(0, 16),
    parameter: String(a.parameter ?? "").slice(0, 32),
    title: String(a.title ?? "").slice(0, 255),
    message: String(a.message ?? ""),
    incentive: a.incentive ?? null,
    value: Number(a.value ?? 0),
    threshold: Number(a.threshold ?? 0),
    rewardIdrPerKwh: a.reward_idr_per_kwh ?? null,
    expectedShedKwh: Number(a.expected_shed_kwh || 0),
    // Absent means "predates the throttle model", which isn't "hold zero watts".
    durationMinutes: a.duration_minutes != null ? Math.trunc(Number(a.duration_minutes)) : null,
    targetReductionW: a.target_reduction_w != null ? Number(a.target_reduction_w) : null,
  };
}

function load(db: DB, alertId: string, tick: number | null | undefined): AlertRow | undefined {
  const where = tick != null ? and(eq(alerts.alertId, alertId), eq(alerts.tick, Math.trunc(tick))) : eq(alerts.alertId, alertId);
  return db.select().from(alerts).where(where).orderBy(desc(alerts.triggeredAt)).limit(1).get();
}

/** Insert the alert as triggered. Idempotent on (alert_id, tick). */
export function recordTrigger(db: DB, alert: AlertLike): void {
  if (!alert.id) return;
  try {
    db.insert(alerts).values(alertColumns(alert)).onConflictDoNothing().run();
  } catch (err) {
    console.error("[DB] recordTrigger failed:", err);
  }
}

/** Record a push attempt, creating the row first if it's somehow missing. */
export function markPushed(
  db: DB,
  alert: AlertLike,
  pushedBy: string | null,
  autoPushed: boolean,
  relayed: boolean,
): void {
  const alertId = String(alert.id ?? "");
  if (!alertId) return;
  try {
    const row = load(db, alertId, alert.tick);
    if (!row) {
      db.insert(alerts)
        .values({
          ...alertColumns(alert),
          pushedAt: new Date(),
          pushedBy,
          autoPushed,
          pushAttempts: 1,
          pushRelayed: relayed,
        })
        .onConflictDoNothing()
        .run();
      return;
    }
    db.update(alerts)
      .set({
        pushedAt: new Date(),
        pushedBy,
        autoPushed,
        pushRelayed: relayed,
        pushAttempts: (row.pushAttempts ?? 0) + 1,
        // A Resend un-ignores: a row that is both ignored and pushed reads as neither.
        ignoredAt: null,
        ignoredBy: null,
      })
      .where(eq(alerts.id, row.id))
      .run();
  } catch (err) {
    console.error("[DB] markPushed failed:", err);
  }
}

/** Stamp delivered_at: the gateway confirmed it relayed this alert. */
export function markDelivered(db: DB, alert: AlertLike): void {
  const alertId = String(alert.id ?? "");
  if (!alertId) return;
  try {
    const row = load(db, alertId, alert.tick);
    if (!row || row.deliveredAt) return;
    db.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, row.id)).run();
  } catch (err) {
    console.error("[DB] markDelivered failed:", err);
  }
}

/** Set or clear the operator's Ignore. Returns whether the alert exists. */
export function markIgnored(db: DB, alertId: string, tick: number | null, ignoredBy: string | null, ignored = true): boolean {
  if (!alertId) return false;
  try {
    const row = load(db, alertId, tick);
    if (!row) return false;
    db.update(alerts)
      .set({ ignoredAt: ignored ? new Date() : null, ignoredBy: ignored ? ignoredBy : null })
      .where(eq(alerts.id, row.id))
      .run();
    return true;
  } catch (err) {
    console.error("[DB] markIgnored failed:", err);
    return false;
  }
}

/** Consecutive accepts this household had going into `when`, stopping at the first decline. */
function streakBefore(db: Conn, userId: string, when: Date): number {
  const rows = db
    .select({ accepted: alertResponses.accepted })
    .from(alertResponses)
    .where(and(eq(alertResponses.userId, userId), lt(alertResponses.respondedAt, when)))
    .orderBy(desc(alertResponses.respondedAt))
    .limit(STREAK_LOOKBACK)
    .all();
  let streak = 0;
  for (const r of rows) {
    if (!r.accepted) break;
    streak++;
  }
  return streak;
}

/** Upsert this household's answer (one vote per household) and snapshot its streak. */
export function recordResponse(
  db: DB,
  alertId: string,
  userId: string,
  accepted: boolean,
  respondedAt?: string | null,
): void {
  if (!alertId || !userId) return;
  try {
    db.transaction((tx) => {
      const alertRow = tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.alertId, alertId), isNotNull(alerts.deliveredAt)))
        .orderBy(desc(alerts.deliveredAt))
        .limit(1)
        .get();
      if (!alertRow) {
        console.log(`[DB] recordResponse: no delivered alert ${alertId}`);
        return;
      }
      const when = parseIso(respondedAt);
      // A decline breaks the run (0); an accept counts itself (first accept = 1).
      const streak = accepted ? streakBefore(tx, userId, when) + 1 : 0;
      tx.insert(alertResponses)
        .values({ alertId: alertRow.id, userId, accepted, respondedAt: when, streakAtResponse: streak })
        .onConflictDoUpdate({
          target: [alertResponses.alertId, alertResponses.userId],
          set: { accepted, respondedAt: when, streakAtResponse: streak },
        })
        .run();
    });
  } catch (err) {
    console.error("[DB] recordResponse failed:", err);
  }
}

/** Reset hides history rather than deleting it: a mid-demo reset shouldn't destroy the record. */
export function clearHistory(db: DB): void {
  try {
    db.update(alerts).set({ clearedAt: new Date() }).where(isNull(alerts.clearedAt)).run();
  } catch (err) {
    console.error("[DB] clearHistory failed:", err);
  }
}
