/** The audit trail. */

import type { Conn } from "./db/client";
import { auditLog, type UserRow } from "./db/schema";

export interface AuditInput {
  actor?: Pick<UserRow, "id" | "username"> | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

/** `actor` null means the system acted on its own (autopush, first-boot seed). */
export function recordAudit(db: Conn, action: string, input: AuditInput = {}): void {
  try {
    db.insert(auditLog)
      .values({
        actorUserId: input.actor?.id ?? null,
        actorLabel: (input.actor?.username ?? "system").slice(0, 64),
        action: action.slice(0, 48),
        targetType: input.targetType?.slice(0, 24) ?? null,
        targetId: input.targetId ? String(input.targetId).slice(0, 64) : null,
        targetLabel: input.targetLabel?.slice(0, 255) ?? null,
        detail: input.detail ?? null,
        ip: input.ip ?? null,
      })
      .run();
  } catch (err) {
    console.error(`[AUDIT] failed to record ${action}:`, err);
  }
}
