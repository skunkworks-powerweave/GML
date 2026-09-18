// Identity schema.
//
// `users` is a PROFILE table. The authoritative identity record lives in
// Supabase's `auth.users`, and `public.users.id` is a foreign key to it
// (ON DELETE RESTRICT -- see _post/003 for why RESTRICT and not CASCADE).
// Rows are created by the `on_auth_user_created` trigger, which is why `id`
// carries no default here: generating one would orphan the profile from the
// auth record it is supposed to mirror.
//
// WHAT USED TO BE HERE, AND WHY IT IS NOT
//
//   password_hash       -> auth.users.encrypted_password
//   email_verified      -> auth.users.email_confirmed_at
//   failed_login_count  -> Supabase Auth rate limiting
//   locked_until        -> ditto. The hand-rolled lockout these two backed was
//                          a DoS in both directions: anyone who knew an address
//                          could lock it at will, the counter never decayed, so
//                          one further guess re-locked it for another hour, and
//                          the distinct error was an account-existence oracle.
//
//   accounts            -> Supabase Auth internals
//   auth_sessions       -> ditto. Both were already inert under Auth.js's
//   verification_tokens    `session: { strategy: "jwt" }` -- the adapter wrote
//                          to them and nothing read them back.
//   password_reset_tokens
//                       -> Supabase password recovery. The flow this backed
//                          bcrypt-compared a submitted token against EVERY live
//                          row, on an endpoint with no rate limit at all.
//
// The 19 foreign keys pointing at users(id) elsewhere in this schema are
// untouched: the uuid is preserved across the move, which is the whole reason
// profiles are keyed to auth.users rather than generated independently.

import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { roleEnum } from "./enums";

// ── users (profile) ────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    // No .defaultRandom(): the id comes from auth.users. See _post/003.
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    name: text("name"),
    hindiName: varchar("hindi_name", { length: 160 }), // v2 (spec 020) — SM-7: always NULLABLE
    phone: varchar("phone", { length: 32 }),
    image: text("image"),
    role: roleEnum("role").notNull().default("teacher"),
    // Profiles are created INACTIVE by the trigger. That default is what makes
    // every account-creation path inert until an administrator acts: the
    // access-token hook refuses to mint a JWT for an inactive profile, so a
    // self-registered account cannot load a single page.
    active: boolean("active").notNull().default(true),
    defaultLocale: varchar("default_locale", { length: 8 }).notNull().default("en"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
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

// TypeScript-side row types.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
