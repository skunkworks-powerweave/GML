// form_drafts — autosave persistence for in-progress feedback / observation form submissions.
// Drives the JSX prototype's "Saved 4s ago" indicator. Drafts are scoped per-user and per-template
// or per-observation-cycle (partial uniques). Cleared on final submit.

import { check, index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { feedbackForms } from "./mentorship";
import { observationCycles } from "./observation";
import { users } from "./identity";

export const formDrafts = pgTable(
  "form_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => feedbackForms.id, { onDelete: "cascade" }),
    observationCycleId: uuid("observation_cycle_id").references(() => observationCycles.id, { onDelete: "cascade" }),
    responses: jsonb("responses").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one of template_id / observation_cycle_id must be non-null.
    check(
      "form_drafts_one_scope",
      sql`(${t.templateId} IS NOT NULL AND ${t.observationCycleId} IS NULL)
          OR (${t.templateId} IS NULL AND ${t.observationCycleId} IS NOT NULL)`,
    ),
    uniqueIndex("form_drafts_user_template_uq")
      .on(t.userId, t.templateId)
      .where(sql`${t.templateId} IS NOT NULL`),
    uniqueIndex("form_drafts_user_cycle_uq")
      .on(t.userId, t.observationCycleId)
      .where(sql`${t.observationCycleId} IS NOT NULL`),
    index("form_drafts_user_idx").on(t.userId, t.updatedAt),
  ],
);

export type FormDraft = typeof formDrafts.$inferSelect;
export type NewFormDraft = typeof formDrafts.$inferInsert;
