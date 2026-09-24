// The /observation list query: one page of the cycles a viewer may see.
//
// WHY PAGES. The list was `.orderBy(desc(scheduled_at)).limit(80)` with no
// page parameter, while its chips counted every visible cycle. Past 80 -- one
// term for a programme of a few hundred teachers -- the chips promised more
// than the table held, nothing said rows were missing, and there was no way to
// reach them from the module's own list. The order was not total either
// (seeded cycles share dates, NULL dates tie), so even the capped slice was
// not a stable window.
//
// Offset paging with an id tiebreaker, as /admin/data pages: enough at this
// programme's scale (thousands of rows), and each row appears on exactly one
// page. Database as a parameter (tests/behaviour runs it); the visibility
// predicate is the caller's and must be passed in.

import { count, desc, eq, type SQL } from "drizzle-orm";
import { observationCycles, subjects, teachers } from "@gml/db/schema";
import type { Db } from "../visibility";

export const CYCLE_PAGE_SIZE = 50;

/** ?page= as a page number: 1 for anything missing, malformed or absurd. */
export function parsePage(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

export async function listCycles(
  db: Db,
  opts: { where: SQL | undefined; page: number; pageSize?: number },
) {
  const pageSize = opts.pageSize ?? CYCLE_PAGE_SIZE;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: observationCycles.id,
        code: observationCycles.code,
        kind: observationCycles.kind,
        status: observationCycles.status,
        scheduledAt: observationCycles.scheduledAt,
        topic: observationCycles.topic,
        videoMin: observationCycles.videoMin,
        teacherName: teachers.fullName,
        teacherHindi: teachers.hindiName,
        subjectName: subjects.name,
      })
      .from(observationCycles)
      .leftJoin(teachers, eq(observationCycles.teacherId, teachers.id))
      .leftJoin(subjects, eq(observationCycles.subjectId, subjects.id))
      .where(opts.where)
      // id breaks ties, so the order is total and pages cannot overlap.
      .orderBy(desc(observationCycles.scheduledAt), desc(observationCycles.id))
      .limit(pageSize)
      .offset((opts.page - 1) * pageSize),
    db.select({ n: count() }).from(observationCycles).where(opts.where),
  ]);
  const totalRows = total?.n ?? 0;
  return {
    rows,
    total: totalRows,
    page: opts.page,
    pageSize,
    /** 1-based index of the first row shown, 0 when the page is empty. */
    from: rows.length === 0 ? 0 : (opts.page - 1) * pageSize + 1,
    to: (opts.page - 1) * pageSize + rows.length,
    hasNext: opts.page * pageSize < totalRows,
  };
}
