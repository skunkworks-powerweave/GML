// audit_log — append-only record of who did what.
// SM-1 enforcement layers:
//   1. DB GRANT REVOKE on UPDATE/DELETE (raw SQL migration ships in spec 011)
//   2. App-level: no `db.update(auditLog)` or `db.delete(auditLog)` anywhere
//   3. CI gate: grep guard in tests/governance (spec 011)
//
// v2 (spec 021): `action` is now varchar(64) supporting dotted notation
// (`gate.attempt.fail`, `whatsapp.media.fetched`, `transcode.success`, etc).
// Convention: `/^[a-z_]+(\.[a-z_]+)*$/`. Documented in docs/audit-actions.md.
//
// Partitioning by month is DEFERRED — see PROGRESS.md.

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
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

// v2 (spec 021): action is free-form varchar(64), not a fixed enum.
// Recommended convention: lower-snake-case + optional dotted prefix
// (`gate.attempt.fail`, `whatsapp.media.fetched`, `transcode.success`, plain
// verbs like `view`/`edit`/`delete` still valid). Documented in docs/audit-actions.md.
export type AuditAction = string;

export type NewAuditEntry = typeof auditLog.$inferInsert;
