// audit_log — append-only record of who did what.
// SM-1 enforcement layers:
//   1. DB GRANT REVOKE on UPDATE/DELETE (lands as raw SQL migration in spec 011)
//   2. App-level: no `db.update(auditLog)` or `db.delete(auditLog)` anywhere
//   3. CI gate: grep guard in tests/governance (lands in spec 011)
//
// Partitioning by month is DEFERRED — see PROGRESS.md "Deferred items".

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditActionEnum } from "./enums";
import { users } from "./identity";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: auditActionEnum("action").notNull(),
    entityType: varchar("entity_type", { length: 64 }),
    entityId: text("entity_id"),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_user_created_idx").on(t.userId, t.createdAt),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_action_created_idx").on(t.action, t.createdAt),
  ],
);

export type AuditAction =
  | "view"
  | "download"
  | "upload"
  | "edit"
  | "delete"
  | "gate_pass"
  | "gate_fail"
  | "login"
  | "logout";

export type NewAuditEntry = typeof auditLog.$inferInsert;
