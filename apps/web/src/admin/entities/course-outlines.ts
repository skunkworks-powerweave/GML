import { z } from "zod";
import { courseOutlines } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const courseOutlinesEntity: AdminEntity = {
  slug: "course-outlines",
  label: "Course outlines",
  table: courseOutlines,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "Name" },
    { key: "subjectId", label: "Subject" },
    { key: "grade", label: "Grade" },
    { key: "term", label: "Term" },
    { key: "weeks", label: "Weeks" },
    { key: "status", label: "Status" },
  ],
  formSchema: z.object({
    subjectId: z.string().uuid(),
    grade: z.coerce.number().int().min(1).max(12),
    term: z.coerce.number().int().min(1).max(6),
    name: z.string().min(2).max(200),
    weeks: z.coerce.number().int().min(1).optional().nullable(),
    sessionsCount: z.coerce.number().int().min(0).default(0),
    ownerTeacherId: z.string().uuid().optional().nullable(),
    status: z.enum(["planned", "in_progress", "complete", "archived"]).default("planned"),
    learningOutcomes: z.array(z.string()).default([]),
  }),
  formFields: ["subjectId", "grade", "term", "name", "weeks", "sessionsCount", "ownerTeacherId", "status", "learningOutcomes"],
  describeRow: (r) => `outline:${r.name ?? r.id}`,
};
