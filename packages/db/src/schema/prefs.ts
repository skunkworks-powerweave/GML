// User preferences — persisted Tweaks Panel state. One row per user.
// Drives the prototype's Tweaks Panel (density/nav-style/a11y/language/watermark).
// SM-7 friendly: locale options stay flexible; no NOT NULL on Hindi-sensitive fields.

import { boolean, check, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";

export const userPrefs = pgTable(
  "user_prefs",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    density: varchar("density", { length: 16 }).notNull().default("regular"),
    navStyle: varchar("nav_style", { length: 16 }).notNull().default("labelled"),
    fontScale: varchar("font_scale", { length: 16 }).notNull().default("regular"),
    highContrast: boolean("high_contrast").notNull().default(false),
    reducedMotion: boolean("reduced_motion").notNull().default(false),
    showWatermark: boolean("show_watermark").notNull().default(true),
    uiLanguage: varchar("ui_language", { length: 8 }).notNull().default("en"),
    ftuxSeenAt: timestamp("ftux_seen_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("user_prefs_density_check", sql`${t.density} IN ('dense','regular','loose')`),
    check("user_prefs_nav_style_check", sql`${t.navStyle} IN ('labelled','icons')`),
    check("user_prefs_font_scale_check", sql`${t.fontScale} IN ('regular','large','xlarge')`),
    check("user_prefs_ui_language_check", sql`${t.uiLanguage} IN ('en','hi','bo')`),
  ],
);

export type UserPrefs = typeof userPrefs.$inferSelect;
