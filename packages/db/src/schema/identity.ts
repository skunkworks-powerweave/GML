// Auth.js v5 (next-auth@beta) Drizzle adapter schema shape + GML LMS-specific extensions.
// Reference: https://authjs.dev/getting-started/adapters/drizzle

import {
  boolean,
  index,
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
    hindiName: varchar("hindi_name", { length: 160 }), // v2 (spec 020) — SM-7: always NULLABLE
    phone: varchar("phone", { length: 32 }),
    image: text("image"),
    passwordHash: text("password_hash"), // null when only magic-link is configured
    role: roleEnum("role").notNull().default("teacher"),
    active: boolean("active").notNull().default(true),
    defaultLocale: varchar("default_locale", { length: 8 }).notNull().default("en"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    // Spec 161 — account-lockout columns. failedLoginCount accumulates
    // consecutive bad-credential attempts; on the 5th hit in a 1h rolling
    // window the authorize callback sets lockedUntil = now()+1h and the
    // counter doesn't decrement until either (a) a successful login flips
    // it back to 0 or (b) super_admin clears it via /admin/users/[id]/unlock.
    // lockedUntil > now() short-circuits the credentials authorize() with a
    // locked_attempt audit row — the attacker can't burn through the bcrypt
    // verify path while the account is locked.
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  // NOTE: no explicit uniqueIndex on `email`. `.unique()` on the column above
  // already emits `CONSTRAINT users_email_unique UNIQUE(email)`, and Postgres
  // implements a unique constraint AS a unique index of the same name. Declaring
  // both made drizzle-kit generate a CREATE UNIQUE INDEX with a name the
  // constraint had already taken, so migration 0000 aborted with
  // `42P07 relation "users_email_unique" already exists` on every fresh
  // database. See docs/verification.md (B15).
);

// ── password_reset_tokens ──────────────────────────────────────────────────────
// Spec 161 — password reset flow. Tokens are 32 random bytes hex-encoded
// (64 chars), bcrypt-hashed at cost 10 BEFORE storage so a DB leak doesn't
// hand attackers usable reset codes. The plaintext lives only in the email
// body; the row holds (hash, expiresAt=now()+30min, consumedAt nullable,
// requestedFromIp masked).
//
// Lookup is by tokenHash (UNIQUE) — the reset page receives the plaintext,
// bcrypt-compares against every unconsumed-non-expired row for that user.
// Volume is tiny (<10/day org-wide) so the linear-scan cost is acceptable.
//
// requestedFromIp is the MASKED ip (last octet stripped, same shape as
// audit.ip) so a DB read doesn't leak per-user IP history.
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    requestedFromIp: varchar("requested_from_ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_hash_unique").on(t.tokenHash),
    index("password_reset_tokens_user_created_idx").on(t.userId, t.createdAt),
  ],
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
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
