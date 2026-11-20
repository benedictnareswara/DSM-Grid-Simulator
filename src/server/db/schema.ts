/** What goes on disk. */

import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const ROLE_ADMIN = "admin";
export const ROLE_CONSUMER = "consumer";
export const STATUS_PENDING = "pending";
export const STATUS_ACTIVE = "active";
export const STATUS_SUSPENDED = "suspended";

/** A person. One admin is seeded at first boot; households register and wait in `pending`. */
export const users = sqliteTable("users", {
  id: id(),
  // Lowercased on write, so "Budi" and "budi" collide instead of becoming two accounts.
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default(ROLE_CONSUMER),
  status: text("status").notNull().default(STATUS_PENDING),
  createdAt: ts("created_at").notNull().default(now),
  lastLoginAt: ts("last_login_at"),
  approvedAt: ts("approved_at"),
  // SET NULL: deleting the approving admin must not delete who they approved.
  approvedBy: text("approved_by").references((): AnySQLiteColumn => users.id, { onDelete: "set null" }),
});

/** One row per issued refresh token, storing only its SHA-256. */
export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().default(now),
  },
  (t) => [index("ix_refresh_tokens_user").on(t.userId)],
);

/** One row per alert the control logic triggered, not per push attempt. */
export const alerts = sqliteTable(
  "alerts",
  {
    id: id(),
    alertId: text("alert_id").notNull(),
    tick: integer("tick").notNull(),
    timestamp: text("timestamp").notNull(),
    severity: text("severity").notNull(),
    parameter: text("parameter").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    incentive: text("incentive"),
    value: real("value").notNull(),
    threshold: real("threshold").notNull(),
    rewardIdrPerKwh: real("reward_idr_per_kwh"),
    // Stored, not recomputed, so retuning the model doesn't restate what past households agreed to.
    expectedShedKwh: real("expected_shed_kwh").notNull().default(0),
    durationMinutes: integer("duration_minutes"),
    targetReductionW: real("target_reduction_w"),
    triggeredAt: ts("triggered_at").notNull().default(now),
    pushedAt: ts("pushed_at"),
    pushedBy: text("pushed_by").references(() => users.id, { onDelete: "set null" }),
    autoPushed: integer("auto_pushed", { mode: "boolean" }).notNull().default(false),
    pushAttempts: integer("push_attempts").notNull().default(0),
    // Whether a gateway was attached when the latest push went out.
    pushRelayed: integer("push_relayed", { mode: "boolean" }).notNull().default(false),
    deliveredAt: ts("delivered_at"),
    ignoredAt: ts("ignored_at"),
    ignoredBy: text("ignored_by").references(() => users.id, { onDelete: "set null" }),
    // A simulation reset hides rows instead of deleting them.
    clearedAt: ts("cleared_at"),
  },
  (t) => [
    // A Resend updates the row (push_attempts) rather than adding a second one.
    uniqueIndex("uq_alert_per_tick").on(t.alertId, t.tick),
    index("ix_alerts_triggered_at").on(t.triggeredAt),
    index("ix_alerts_delivered_at").on(t.deliveredAt),
  ],
);

/** One household's answer to one alert. */
export const alertResponses = sqliteTable(
  "alert_responses",
  {
    id: id(),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accepted: integer("accepted", { mode: "boolean" }).notNull(),
    respondedAt: ts("responded_at").notNull(),
    // How many accepts in a row this one made, counting itself (0 on a decline).
    streakAtResponse: integer("streak_at_response").notNull().default(0),
  },
  (t) => [
    uniqueIndex("uq_response_per_user").on(t.alertId, t.userId),
    index("ix_alert_responses_user").on(t.userId),
  ],
);

/** Who did what, and when. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    // NULL when the system acted on its own (autopush, first-boot seed).
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull().default("system"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().default(now),
    // "Clear log" hides rows; it never deletes them.
    clearedAt: ts("cleared_at"),
  },
  (t) => [
    index("ix_audit_created_at").on(t.createdAt),
    index("ix_audit_action").on(t.action),
    index("ix_audit_target").on(t.targetId),
    index("ix_audit_actor").on(t.actorUserId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type AlertResponseRow = typeof alertResponses.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;

// ── Audit action verbs ───────────────────────────────────────────────────────
export const AUDIT = {
  USER_REGISTER: "user.register",
  USER_LOGIN: "user.login",
  USER_APPROVE: "user.approve",
  USER_SUSPEND: "user.suspend",
  USER_REINSTATE: "user.reinstate",
  USER_DELETE: "user.delete",
  USER_PASSWORD: "user.password_reset",
  ALERT_PUSH: "alert.push",
  ALERT_IGNORE: "alert.ignore",
  ALERT_UNIGNORE: "alert.unignore",
  ALERT_RESPOND: "alert.respond",
  SIM_CONTROL: "simulation.control",
  SIM_RESET: "simulation.reset",
  SIM_THRESHOLDS: "simulation.thresholds",
  AUDIT_CLEAR: "audit.clear",
} as const;
