// Notifications — per-user feed of operational events.
// SM-8: retention ≤ 90 days. Daily scheduled job (lands in spec 039 BullMQ worker)
// deletes rows older than 90 days. CI gate verifies the retention script exists.

import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./identity";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 40 }).notNull(),       // e.g. cycle.assigned, video.transcoded
    subject: varchar("subject", { length: 200 }).notNull(),
    body: text("body"),
    entityType: varchar("entity_type", { length: 64 }),
    entityId: text("entity_id"),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // (user, unread-first, recent-first) for the inbox feed
    index("notifications_user_unread_idx").on(t.userId, t.readAt, t.createdAt),
    index("notifications_created_idx").on(t.createdAt), // for SM-8 retention scan
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
