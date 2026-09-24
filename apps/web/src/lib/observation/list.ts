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

import { count, desc, eq, sql, type SQL } from "drizzle-orm";
import { observationCycles, subjects, teachers, videoSubmissions } from "@gml/db/schema";
import type { Db } from "../visibility";

export const CYCLE_PAGE_SIZE = 50;

/**
 * The list's Video cell: minutes of ready video, the number of videos when
 * their duration is unknown, "processing" while one is still in the pipeline,
 * and "—" when there is none.
 */
export function videoCell(v: { videosReady: number; videosReadySec: number; videosProcessing: number }): string {
  if (v.videosReady > 0) {
    if (v.videosReadySec > 0) return `${Math.max(1, Math.round(v.videosReadySec / 60))}m`;
    return `${v.videosReady} video${v.videosReady === 1 ? "" : "s"}`;
  }
  if (v.videosProcessing > 0) return "processing";
  return "—";
}

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
  const pageRows = (page: number) =>
    db
      .select({
        id: observationCycles.id,
        code: observationCycles.code,
        kind: observationCycles.kind,
        status: observationCycles.status,
        scheduledAt: observationCycles.scheduledAt,
        topic: observationCycles.topic,
        // THE CYCLE'S VIDEOS, not observation_cycles.video_min. That column is
        // written only by the demo seed -- no nomination, upload, webhook or
        // transcode sets it -- so a real cycle with a ready lesson video showed
        // "—" and a demo cycle with no video showed minutes. Keyed on the
        // video's context (as uploads and the WhatsApp webhook both record
        // it), covered by video_submissions_context_idx.
        videosReady: sql<number>`(SELECT count(*)::int FROM ${videoSubmissions} v
          WHERE v.context_type = 'observation_cycle' AND v.context_id = ${observationCycles.id}
            AND v.status = 'ready')`,
        videosReadySec: sql<number>`(SELECT coalesce(sum(v.duration_sec), 0)::int FROM ${videoSubmissions} v
          WHERE v.context_type = 'observation_cycle' AND v.context_id = ${observationCycles.id}
            AND v.status = 'ready')`,
        videosProcessing: sql<number>`(SELECT count(*)::int FROM ${videoSubmissions} v
          WHERE v.context_type = 'observation_cycle' AND v.context_id = ${observationCycles.id}
            AND v.status IN ('received', 'queued', 'transcoding'))`,
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
      .offset((page - 1) * pageSize);
  let page = opts.page;
  const [requested, [total]] = await Promise.all([
    pageRows(page),
    db.select({ n: count() }).from(observationCycles).where(opts.where),
  ]);
  const totalRows = total?.n ?? 0;
  // PAST THE END IS THE LAST PAGE. A stale ?page= -- a link kept across a
  // filter change or deletions -- rendered "No observation cycles match this
  // filter." beside "Showing 0–100 of 85". Only that case pays a second query.
  const lastPage = Math.max(1, Math.ceil(totalRows / pageSize));
  let rows = requested;
  if (page > lastPage) {
    page = lastPage;
    rows = await pageRows(page);
  }
  return {
    rows,
    total: totalRows,
    /** The page shown: the requested one, or the last page if that was past the end. */
    page,
    pageSize,
    /** 1-based index of the first row shown, 0 when the page is empty. */
    from: rows.length === 0 ? 0 : (page - 1) * pageSize + 1,
    to: rows.length === 0 ? 0 : (page - 1) * pageSize + rows.length,
    hasNext: page * pageSize < totalRows,
  };
}
