// Postgres-backed rate limiting.
//
// Replaces a Redis sliding window whose failure mode was worse than no limiter
// at all. `getRedis()` set `maxRetriesPerRequest: null` with no
// `commandTimeout` and left the offline queue enabled, so when Redis was
// unreachable commands did not reject -- they QUEUED INDEFINITELY. `rateLimit()`
// therefore never resolved, the carefully documented fail-closed `catch` in
// rate-limit.ts was unreachable code, and every login request hung until the
// browser gave up. A limiter that hangs the thing it protects is a denial of
// service with extra steps.
//
// A fixed-window counter in Postgres is less elegant than a sliding window and
// entirely adequate: the limits here are "5 attempts per 15 minutes", where the
// worst case at a window boundary is 10 attempts in 15 minutes. That is not the
// difference between safe and unsafe, and it buys a limiter that shares the
// application's own connection pool -- so if it is down, the application is
// down too, and there is no separate thing to fail open.

import { index, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const rateLimits = pgTable(
  "rate_limits",
  {
    /** Bucket name plus caller identity, e.g. "gate:203.0.113.7:<uuid>:mentorship". */
    key: varchar("key", { length: 256 }).primaryKey(),

    /** Start of the current window. */
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    count: integer("count").notNull().default(0),
  },
  (t) => [
    // Sweeping expired rows. Without this the table grows by one row per
    // distinct caller forever, and the cleanup scan becomes the slowest thing
    // in the system precisely when it is under attack.
    index("rate_limits_window_idx").on(t.windowStart),
  ],
);

export type RateLimit = typeof rateLimits.$inferSelect;
