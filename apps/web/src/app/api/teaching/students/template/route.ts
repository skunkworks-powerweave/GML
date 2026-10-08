// GET /api/teaching/students/template -> the header row of the students CSV
// (name, rollNumber, section, class) for a teacher to fill in and upload on
// "My students". Teachers only (403 otherwise, 401 signed out). It holds no
// learner, so nothing is audited.

import { requireApiRole } from "@/lib/api-guards";
import { csvDownload } from "@/lib/teaching/csv";
import { TEMPLATE_COLUMNS } from "@/lib/teaching/students-csv";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireApiRole(["teacher"]);
  if (gate.response) return gate.response;
  return csvDownload("students-template.csv", TEMPLATE_COLUMNS, []);
}
