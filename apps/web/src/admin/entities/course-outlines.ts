import { z } from "zod";
import { courseOutlines, RECORD_APPROVAL_STATES } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const courseOutlinesEntity: AdminEntity = {
  slug: "course-outlines",
  table: courseOutlines,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name" },
    { key: "subjectId" },
    { key: "grade" },
    { key: "term" },
    { key: "weeks" },
    { key: "status" },
    // Migration 0043: whose plan it is (empty = the programme's outline), and
    // its approval state -- shown, and moved only by the approvals queue.
    { key: "ownerTeacherId" },
    { key: "approvalStatus", choices: RECORD_APPROVAL_STATES },
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
