// Named reading materials accessible from the repository. Many-to-many with
// curriculum subjects (one resource can span multiple subjects).

import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { subjects } from "./subjects";

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 240 }).notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    owner: varchar("owner", { length: 120 }),
    pages: integer("pages"),
    fileKey: text("file_key"),       // MinIO object key (real after spec 037)
    externalUrl: text("external_url"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "resources_kind_check",
      sql`${t.kind} IN ('Policy','Guide','Handbook','Worksheet','Template','Routine','Calendar','Checklist','Lab-guide','Rubric','Other')`,
    ),
    check("resources_pages_check", sql`${t.pages} IS NULL OR ${t.pages} > 0`),
    check(
      "resources_has_source_check",
      sql`${t.fileKey} IS NOT NULL OR ${t.externalUrl} IS NOT NULL`,
    ),
  ],
);

export const resourceSubjects = pgTable(
  "resource_subjects",
  {
    resourceId: uuid("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.resourceId, t.subjectId] })],
);

export type Resource = typeof resources.$inferSelect;
export type ResourceSubject = typeof resourceSubjects.$inferSelect;
