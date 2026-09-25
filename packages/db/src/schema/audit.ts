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

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deliberately NOT a foreign key. See migration 0023.
    //
    // It was `references(() => users.id, { onDelete: "set null" })`, and
    // "SET NULL" is an UPDATE — which audit_log's own BEFORE UPDATE trigger
    // rejects, because the table is append-only (SM-1). The two features
    // cancelled out, so any user who had ever acted could never be deleted:
    //   DELETE user -> "audit_log is append-only (SM-1). UPDATE blocked."
    // (The SET NULL is the UPDATE. The message said "UPDATE/DELETE blocked."
    // until _post/007 made it name the operation; 0023's header quotes it as
    // it was then.)
    //
    // CASCADE would be worse — deleting a user would erase their own trail.
    // A forensic log should carry no referential action at all: it records what
    // was true at the time and is never revised. Attribution survives the actor.
    //
    // Consequence: this may reference a deleted user. Always LEFT JOIN.
    userId: uuid("user_id"),
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
    // The UNFILTERED /admin/audit view -- the default, no user and no action
    // selected -- is `ORDER BY created_at DESC LIMIT 50`, and the CSV export
    // is the same shape with a bigger limit. None of the three above can serve
    // it: a btree orders by its LEADING column, so (user_id, created_at) and
    // (action, created_at) leave created_at unordered across the table, and
    // the planner falls back to a seq scan plus a sort of all of it. This is
    // the one table with no delete path (_post/001), so that cost only grows.
    //
    // Plain ASC is enough: a btree scans backward, so this serves DESC too.
    // Created by migration 0028 -- declared here so the schema stays the one
    // source of truth and drizzle-kit never generates it a second time.
    index("audit_log_created_idx").on(t.createdAt),
  ],
);

// v2 (spec 021): action is free-form varchar(64), not a fixed enum.
// Recommended convention: lower-snake-case + optional dotted prefix
// (`gate.attempt.fail`, `whatsapp.media.fetched`, `transcode.success`, plain
// verbs like `view`/`edit`/`delete` still valid). Documented in docs/audit-actions.md.
export type AuditAction = string;

export type NewAuditEntry = typeof auditLog.$inferInsert;
