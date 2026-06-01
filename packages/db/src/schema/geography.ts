// Geography hierarchy: districts → zones → schools → teachers.
// Seeded with Leh + Kargil (districts) and the 6 Kargil zones in spec 086.

import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { phases } from "./rtt";
import { users } from "./identity";

export const districts = pgTable("districts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 80 }).notNull().unique(),
  code: varchar("code", { length: 16 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const zones = pgTable(
  "zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    districtId: uuid("district_id").notNull().references(() => districts.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zones_district_name_uq").on(t.districtId, t.name)],
);

export const schools = pgTable(
  "schools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zoneId: uuid("zone_id").notNull().references(() => zones.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 16 }).notNull().unique(), // v2 (spec 020): e.g. "GPS-CHU", "GMS-KHA"
    name: varchar("name", { length: 160 }).notNull(),
    address: text("address"),
    contactPhone: varchar("contact_phone", { length: 32 }),
    headTeacherName: varchar("head_teacher_name", { length: 160 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("schools_zone_idx").on(t.zoneId)],
);

export const teachers = pgTable(
  "teachers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    hindiName: varchar("hindi_name", { length: 160 }), // v2 (spec 020) — SM-7: always NULLABLE
    phone: varchar("phone", { length: 32 }),
    subjectSpecialism: varchar("subject_specialism", { length: 80 }),
    joinedPhase: varchar("joined_phase", { length: 16 }),
    currentPhaseId: uuid("current_phase_id").references(() => phases.id, { onDelete: "set null" }), // v2 (spec 020)
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("teachers_school_idx").on(t.schoolId)],
);

export type District = typeof districts.$inferSelect;
export type Zone = typeof zones.$inferSelect;
export type School = typeof schools.$inferSelect;
export type Teacher = typeof teachers.$inferSelect;
