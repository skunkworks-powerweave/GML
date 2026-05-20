// Section gates — rotatable passwords gating major content areas (mentorship,
// observation, TKT, TTT). Enforces substrate moat SM-2 (grants ≤ 8h) at the DB
// layer via CHECK constraint.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sectionGateSlugEnum } from "./enums";
import { users } from "./identity";

// Current and historical password versions. Most-recent version per slug is
// active; old versions retained so already-issued grants don't immediately break.
export const sectionGates = pgTable("section_gates", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: sectionGateSlugEnum("slug").notNull(),
  passwordHash: text("password_hash").notNull(),
  version: integer("version").notNull().default(1),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  rotatedByUserId: uuid("rotated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// Per-user grant after passing the gate. Expires within 8h, enforced by CHECK.
export const sectionGateGrants = pgTable(
  "section_gate_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gateSlug: sectionGateSlugEnum("gate_slug").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ip: varchar("ip", { length: 64 }),
  },
  (t) => [
    // SM-2 enforcement: no grant outlives 8h.
    check(
      "section_gate_grants_expires_within_8h",
      sql`${t.expiresAt} <= ${t.grantedAt} + interval '8 hours'`,
    ),
    index("section_gate_grants_user_slug_idx").on(t.userId, t.gateSlug, t.expiresAt),
  ],
);

export type SectionGate = typeof sectionGates.$inferSelect;
export type SectionGateGrant = typeof sectionGateGrants.$inferSelect;
