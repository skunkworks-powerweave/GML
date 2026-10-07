import { z } from "zod";
import { rttModules } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT modules — the units a training subject is broken into.
//
// WHY THIS ENTITY EXISTS. The gap entities/rtt-sessions.ts closed, one table
// over. /rtt/subject/[id] reads rtt_modules on every render and nothing wrote
// it: no action, no API route, no seed, no migration INSERT. So "Modules (0) --
// No modules yet." was permanent on every subject page, and authoring one meant
// hand-written SQL against production.
//
// Registering the slug also brings CSV import into play, which is the realistic
// way to load a term of content in one pass.
//
// Test: tests/behaviour/admin-entities.test.ts.
export const rttModulesEntity: AdminEntity = {
  slug: "rtt-modules",
  table: rttModules,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "rttSubjectId" },
    { key: "sequence" },
    { key: "title" },
    { key: "description" },
  ],
  formSchema: z.object({
    rttSubjectId: z.string().uuid(),
    // The subject page orders by it; NOT NULL.
    sequence: z.coerce.number().int().min(1).max(999),
    title: z.string().trim().min(2).max(240),
    description: z.string().max(5000).optional().nullable(),
    // The syllabus block. Only title and description render today, but these
    // columns have no other write path either.
    learningObjectives: z.string().max(5000).optional().nullable(),
    courseObjectives: z.string().max(5000).optional().nullable(),
    assuranceOfLearning: z.string().max(5000).optional().nullable(),
    evaluationCriteria: z.string().max(5000).optional().nullable(),
    textbookRefs: z.string().max(5000).optional().nullable(),
  }),
  formFields: [
    "rttSubjectId",
    "sequence",
    "title",
    "description",
    "learningObjectives",
    "courseObjectives",
    "assuranceOfLearning",
    "evaluationCriteria",
    "textbookRefs",
  ],
  // A training subject's modules re-uploaded after a partial import (csv.ts): the same title at the same
  // position under the same parent is the same row. The title leads because it is
  // what tells the rows of one parent apart, so a file of thousands is not
  // compared against itself in one lump.
  duplicateKey: ["title", "rttSubjectId", "sequence"],
  describeRow: (r) => `rtt-module:${r.title ?? r.id}`,
};
