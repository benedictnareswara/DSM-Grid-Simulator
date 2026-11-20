/** Turning rows into the wire shapes in src/lib/types.ts. */

import { inArray } from "drizzle-orm";
import type {
  AlertOutcome,
  AuditEntry,
  ParticipationEntry,
  PersistedAlert,
  ResponseSummary,
  User,
  UserRole,
  UserStatus,
} from "@/lib/types";
import { DELIVERY_GRACE_MS } from "@/lib/constants";
import type { Conn } from "./db/client";
import { users, type AlertResponseRow, type AlertRow, type AuditRow, type UserRow } from "./db/schema";
import * as incentives from "./grid/incentives";

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** An account as the API exposes it. The password hash is never read here, so it can't leak. */
export function userOut(user: UserRow, approvedByUsername: string | null = null): User {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role as UserRole,
    status: user.status as UserStatus,
    created_at: iso(user.createdAt),
    approved_at: iso(user.approvedAt),
    approved_by_username: approvedByUsername,
    last_login_at: iso(user.lastLoginAt),
  };
}

/** `{id: username}` for a set of user ids, in one query. Missing ids are normal (deleted, or autopush). */
export function usernames(db: Conn, ids: Iterable<string | null | undefined>): Map<string, string> {
  const wanted = [...new Set([...ids].filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, wanted)).all();
  return new Map(rows.map((r) => [r.id, r.username]));
}

/** The single value the admin feed switches on. */
export function alertOutcome(a: AlertRow, now: number = Date.now()): AlertOutcome | null {
  if (a.ignoredAt) return "ignored";
  if (a.deliveredAt) return a.autoPushed ? "auto-pushed" : "pushed";
  if (a.pushedAt) {
    const inFlight = a.pushRelayed && now - a.pushedAt.getTime() < DELIVERY_GRACE_MS;
    return inFlight ? "sending" : "failed-gateway";
  }
  return null;
}

export function alertItem(
  a: AlertRow,
  responses: ResponseSummary[],
  opts: { myResponse?: boolean | null; pushedByUsername?: string | null } = {},
): PersistedAlert {
  return {
    id: a.id,
    alert_id: a.alertId,
    tick: a.tick,
    timestamp: a.timestamp,
    severity: a.severity as PersistedAlert["severity"],
    parameter: a.parameter,
    title: a.title,
    message: a.message,
    incentive: a.incentive,
    value: a.value,
    threshold: a.threshold,
    reward_idr_per_kwh: a.rewardIdrPerKwh,
    expected_shed_kwh: a.expectedShedKwh ?? 0,
    duration_minutes: a.durationMinutes,
    target_reduction_w: a.targetReductionW,
    triggered_at: iso(a.triggeredAt)!,
    pushed_at: iso(a.pushedAt),
    pushed_by_username: opts.pushedByUsername ?? null,
    auto_pushed: a.autoPushed,
    push_attempts: a.pushAttempts ?? 0,
    delivered_at: iso(a.deliveredAt),
    ignored_at: iso(a.ignoredAt),
    outcome: alertOutcome(a),
    responses,
    my_response: opts.myResponse ?? null,
  };
}

/** One answer, flattened with the alert it answers and what it earned. */
export function participationEntry(
  r: AlertResponseRow,
  a: AlertRow,
  username: string | undefined,
  pushedByUsername: string | null = null,
): ParticipationEntry {
  const latency = incentives.latencySeconds(a.deliveredAt, r.respondedAt);
  const streak = r.streakAtResponse ?? 0;
  const shed = a.expectedShedKwh ?? 0;

  let bonus = 1.0;
  let bonusLabel: string | null = null;
  let streakMult = 1.0;
  let credit = 0.0;
  if (r.accepted) {
    bonus = incentives.responseBonus(latency);
    bonusLabel = incentives.responseBonusLabel(latency);
    streakMult = incentives.streakMultiplier(streak);
    credit = incentives.creditIdr(a.rewardIdrPerKwh, shed, latency, streak);
  }

  return {
    id: r.id,
    alert_id: a.alertId,
    alert_title: a.title,
    alert_severity: a.severity as ParticipationEntry["alert_severity"],
    alert_parameter: a.parameter,
    alert_message: a.message,
    alert_incentive: a.incentive,
    tick: a.tick,
    user_id: r.userId,
    username: username ?? "(deleted)",
    accepted: r.accepted,
    responded_at: iso(r.respondedAt)!,
    reward_idr_per_kwh: a.rewardIdrPerKwh,
    triggered_at: iso(a.triggeredAt),
    pushed_at: iso(a.pushedAt),
    pushed_by_username: pushedByUsername,
    auto_pushed: a.autoPushed,
    delivered_at: iso(a.deliveredAt),
    expected_shed_kwh: shed,
    latency_seconds: latency,
    streak_at_response: streak,
    response_bonus: bonus,
    response_bonus_label: bonusLabel,
    streak_multiplier: streakMult,
    credit_idr: credit,
  };
}

export function auditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    actor_user_id: row.actorUserId,
    actor_label: row.actorLabel,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    target_label: row.targetLabel,
    detail: row.detail ?? null,
    ip: row.ip,
    created_at: iso(row.createdAt)!,
  };
}
