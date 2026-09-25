// system_settings — singleton row for platform-wide knobs the admin can tweak.
//
// Spec 124 (Workflow Run 10 frontend-parity) — closes the deviation noted in spec 071
// where the JSX prototype tweaks-panel.jsx (lines 276-337) renders five admin
// configuration sections (Programme, Video pipeline, Notifications, Backups &
// retention, last-backup/restore status) but no backing table existed.
//
// Singleton enforcement (defence-in-depth):
//   1. PK column carries a CHECK constraint pinning id to the well-known nil-uuid+1
//      sentinel '00000000-0000-0000-0000-000000000001'. The DB rejects any INSERT
//      that tries to use a different id, so even a bug that bypasses the upsert
//      helper can't create a second row.
//   2. Seed helper bootstrapSystemSettings() runs from packages/db/src/scripts/seed.ts
//      and uses ON CONFLICT DO NOTHING against the same PK, so a re-run is a no-op.
//   3. The /api/admin/system-settings PUT handler always upserts on the same id —
//      the row count is invariant after bootstrap.
//
// SM-4 (anti-download): videoDefaultQuality is constrained to '480p' today; the
// route enforces this at the zod layer until spec 042's HLS-360p variant ships.
// 720p was deferred in spec 041 and 1080p was never a goal — the dropdown will
// show those options as disabled with a tooltip in the page UI.

import { check, jsonb, pgTable, timestamp, uuid, varchar, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Single well-known UUID that every system_settings row must use.
// Exported so the API route, seed helper, and tests can reference one source of truth.
export const SYSTEM_SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

export const systemSettings = pgTable(
  "system_settings",
  {
    id: uuid("id").primaryKey(),
    programmeName: varchar("programme_name", { length: 200 }).notNull().default("Goldenmile RTT"),
    academicYear: varchar("academic_year", { length: 16 }).notNull().default("2026-27"),
    videoDefaultQuality: varchar("video_default_quality", { length: 8 }).notNull().default("480p"),
    videoMaxUploadMb: integer("video_max_upload_mb").notNull().default(500),
    // Categories the admin has enabled for notification delivery. Extra categories
    // (digest, reminders) are off by default.
    //
    // `helpdesk.ticket` MUST be in this default. It is the only kind anything in
    // the application actually writes, and the bell counts unread rows filtered
    // by this array -- so a default without it means every fresh deployment
    // ships a bell that can never be anything but zero, while help requests pile
    // up unseen in the inbox. See _post/006 for the same fix applied to rows
    // already written, and apps/web/src/lib/notification-kinds.ts for the
    // catalogue this must remain a subset of.
    //
    // `meeting.cancelled` and `cycle.complete` were missing for the same
    // reason: the list was chosen before anything wrote them. Their producers
    // (cancelMeetingAction, the cycle sign-off) then wrote rows that /inbox and
    // the bell hid, while the pairing page told the mentor the mentee "will be
    // told". Every kind the application writes belongs here unless there is a
    // stated reason it should be off. See _post/010, and _post/011 for
    // `pairing.final_submitted`, added with its producer.
    notificationsEnabled: jsonb("notifications_enabled")
      .$type<string[]>()
      .notNull()
      .default(
        sql`'["helpdesk.ticket","cycle.assigned","cycle.complete","video.transcoded","meeting.scheduled","meeting.cancelled","pairing.final_submitted"]'::jsonb`,
      ),
    backupRetentionDays: integer("backup_retention_days").notNull().default(14),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Singleton constraint — only the sentinel uuid is acceptable. Belt-and-braces against
    // a bug that bypasses the seed helper and tries to insert a second row.
    check(
      "system_settings_singleton",
      sql`${t.id} = '00000000-0000-0000-0000-000000000001'::uuid`,
    ),
  ],
);

export type SystemSettings = typeof systemSettings.$inferSelect;
export type NewSystemSettings = typeof systemSettings.$inferInsert;
