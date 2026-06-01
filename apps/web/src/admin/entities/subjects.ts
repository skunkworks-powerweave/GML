import { z } from "zod";
import { subjects } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// Curriculum subjects (English / Math / EVS / Hindi / Urdu / Science / SS / Art / Ladakhi Studies).
// The spine that classes, course outlines, classroom sessions, and resources reference.
// Distinct from rtt-subjects (training units inside an RTT phase/term).
export const subjectsEntity: AdminEntity = {
  slug: "subjects",
  label: "Subjects (curriculum)",
  table: subjects,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "Name" },
    { key: "code", label: "Code" },
    { key: "color", label: "Color" },
    { key: "gradesMin", label: "Grades from" },
    { key: "gradesMax", label: "Grades to" },
    { key: "displayOrder", label: "Order" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(120),
    code: z.string().min(2).max(24).regex(/^[A-Z][A-Z0-9_-]*$/, "Uppercase code (e.g. ENG, MAT, EVS)"),
    color: z.string().max(16).optional().nullable(),
    gradesMin: z.coerce.number().int().min(1).max(12).optional().nullable(),
    gradesMax: z.coerce.number().int().min(1).max(12).optional().nullable(),
    displayOrder: z.coerce.number().int().min(0).default(0),
    active: z.boolean().default(true),
  }).refine(
    (v) => v.gradesMin == null || v.gradesMax == null || v.gradesMin <= v.gradesMax,
    { message: "grades_min must be ≤ grades_max", path: ["gradesMin"] },
  ),
  formFields: ["name", "code", "color", "gradesMin", "gradesMax", "displayOrder", "active"],
  describeRow: (r) => `subject:${r.code ?? r.name ?? r.id}`,
};
