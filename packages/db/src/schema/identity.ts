// Auth.js v5 (next-auth@beta) Drizzle adapter schema shape + GML LMS-specific extensions.
// Reference: https://authjs.dev/getting-started/adapters/drizzle

import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { roleEnum } from "./enums";

// ── users ──────────────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
    name: text("name"),
    phone: varchar("phone", { length: 32 }),
    image: text("image"),
    passwordHash: text("password_hash"), // null when only magic-link is configured
    role: roleEnum("role").notNull().default("teacher"),
    active: boolean("active").notNull().default(true),
    defaultLocale: varchar("default_locale", { length: 8 }).notNull().default("en"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

// ── accounts (OAuth providers — placeholder, used when SSO is added) ───────────
export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refreshToken: text("refresh_token"),
    accessToken: text("access_token"),
    expiresAt: integer("expires_at"),
    tokenType: text("token_type"),
    scope: text("scope"),
    idToken: text("id_token"),
    sessionState: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

// ── auth sessions (DB-backed Auth.js sessions if we ever opt-in; JWT default) ─
// v2 rename (spec 017): was `sessions`. Renamed to `auth_sessions` to free the bare
// `sessions` table name for the classroom-sessions module (curriculum-side).
export const authSessions = pgTable("auth_sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

// ── verification tokens (magic-link flow) ──────────────────────────────────────
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// TypeScript-side row types.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type AuthSession = typeof authSessions.$inferSelect;
