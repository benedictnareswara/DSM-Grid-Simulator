import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { UserProfile } from "@/lib/types";
import { approverName, loadTarget, type IdParams } from "@/server/admin";
import { alertResponses, auditLog } from "@/server/db/schema";
import { reliability } from "@/server/grid/incentives";
import { pyRound } from "@/server/grid/pyround";
import { participationRows, toParticipation } from "@/server/history";
import { json, requireAdmin, route } from "@/server/http";
import { auditEntry, userOut } from "@/server/serialize";

/**
 * Everything the account page shows: profile, answers, reliability and audit
 * trail. The audit query matches both what was done *to* the account and what
 * it did itself.
 */
export const GET = route<IdParams>(async (req, { rt, params }) => {
  await requireAdmin(req, rt);
  const user = loadTarget(rt.db, (await params).id);

  const entries = toParticipation(rt.db, participationRows(rt.db, eq(alertResponses.userId, user.id), 50));
  const accepted = entries.filter((e) => e.accepted);
  const credit = accepted.reduce((s, e) => s + (e.credit_idr ?? 0), 0);
  const totalKwh = accepted.reduce((s, e) => s + (e.expected_shed_kwh ?? 0), 0);

  // Reliability reads every answer (a fast "no" isn't dependable). Unmeasurable
  // latencies are left out rather than counted as slow.
  const latencies = entries
    .map((e) => e.latency_seconds)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const medianLatency = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const acceptRate = entries.length ? accepted.length / entries.length : 0.0;
  // Newest first, so the current run is the newest answer's stored streak.
  const currentStreak = entries.length && entries[0].accepted ? (entries[0].streak_at_response ?? 0) : 0;

  const audit = rt.db
    .select()
    .from(auditLog)
    .where(and(isNull(auditLog.clearedAt), or(eq(auditLog.targetId, user.id), eq(auditLog.actorUserId, user.id))))
    .orderBy(desc(auditLog.createdAt))
    .limit(50)
    .all();

  const profile: UserProfile = {
    user: userOut(user, approverName(rt.db, user)),
    accepted_count: accepted.length,
    declined_count: entries.length - accepted.length,
    estimated_credit_idr: pyRound(credit, 2),
    total_kwh: pyRound(totalKwh, 3),
    reliability_score: reliability(acceptRate, medianLatency),
    accept_rate: pyRound(acceptRate, 4),
    median_latency_seconds: medianLatency,
    current_streak: currentStreak,
    recent_responses: entries,
    recent_audit: audit.map(auditEntry),
  };
  return json(profile);
});
