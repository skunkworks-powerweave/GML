// /admin/transcode-jobs — Transcode DLQ admin surface (Workflow Run 15
// audit-closure MISS: failed transcode jobs land in the BullMQ DLQ with
// no operator UI to inspect or retry them).
//
// Spec 162 ships the DB-backed inspection view + a pair of operator
// verbs (Retry, Drop) that map onto the real BullMQ queue and the
// transcode_jobs table. The same role gate as /admin/whatsapp-log
// (programme_admin + super_admin) — the DLQ is a programme-oversight
// surface, not a teacher-facing tool.
//
// Surface shape:
//
//   - Top strip: live BullMQ queue depth (waiting / active / failed /
//     delayed) pulled via transcodeQueue.getJobCounts. The TS schema
//     and the BullMQ queue can drift — failed-in-DB and failed-in-Redis
//     are independent — so surfacing both lets the operator see when
//     the two views are out of sync (a Redis flush left rows in the DB
//     with no live queue entry, for example).
//   - Filter pills: All / Failed / In progress / Queued / Recent (24h).
//     Pills are <Link> elements so the URL drives the filter (the same
//     pattern /admin/whatsapp-log uses) — no client component required.
//   - Table: status chip, source chip, video link, error excerpt,
//     attempts, last-updated, action column.
//   - Action column: Retry button (failed rows only — re-enqueues onto
//     transcodeQueue with the same payload) and Drop button (terminal
//     verb; marks the row 'dropped' without re-enqueue).
//
// Audit anchor: every Retry / Drop call records an audit row so the
// operator's decision is traceable. Same dotted-action convention
// (transcode.retry_requested / transcode.dropped) used elsewhere.

import Link from "next/link";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { transcodeJobs, videoSubmissions } from "@gml/db/schema";
import { transcodeQueue } from "@gml/worker/queues";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { retryTranscodeJobAction, dropTranscodeJobAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 100;

// Filter values accepted via ?filter=<x>. Anything else falls through to
// 'all'. The labels mirror the pill button captions.
const FILTERS = ["all", "failed", "in_progress", "queued", "recent"] as const;
type FilterKey = (typeof FILTERS)[number];

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  failed: "Failed",
  in_progress: "In progress",
  queued: "Queued",
  recent: "Recent (24h)",
};

// Status → chip class. Aligns with the convention in /admin/whatsapp-log
// (lichen=ok, saffron=in-flight, rust=failure, indigo=human-decided).
const STATUS_CHIP: Record<string, string> = {
  queued: "chip",
  running: "chip chip-saffron",
  succeeded: "chip chip-lichen",
  failed: "chip chip-rust",
  cancelled: "chip chip-indigo",
  dropped: "chip chip-indigo",
};

// The four "live" BullMQ states we surface at the top. delayed is
// included because spec 151 added exponential backoff (5s, 10s, 20s)
// and a job between attempts shows up as 'delayed' — the operator
// needs to see that depth too or they'll mistake delayed jobs for
// stuck ones.
type QueueDepth = {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
};

async function loadDlqDepth(): Promise<QueueDepth | null> {
  try {
    const counts = await transcodeQueue.getJobCounts(
      "waiting",
      "active",
      "failed",
      "delayed",
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch (err) {
    // Redis unreachable / queue not initialised — return null so the
    // top strip shows a "depth unavailable" hint rather than misleading
    // zeros. The DB table view is still usable.
    console.error("[transcode-jobs] loadDlqDepth failed", err);
    return null;
  }
}

function resolveFilter(raw: string | undefined): FilterKey {
  if (raw && (FILTERS as readonly string[]).includes(raw)) {
    return raw as FilterKey;
  }
  return "all";
}

// Order: failed first (the DLQ-relevant rows), then queued/running,
// then succeeded (so operators see the full picture without scrolling
// through hundreds of healthy completions). dropped/cancelled rows
// land at the bottom because they're terminal-non-actionable.
const STATUS_SORT_ORDER = sql<number>`CASE ${transcodeJobs.status}
  WHEN 'failed' THEN 0
  WHEN 'running' THEN 1
  WHEN 'queued' THEN 2
  WHEN 'succeeded' THEN 3
  WHEN 'cancelled' THEN 4
  WHEN 'dropped' THEN 5
  ELSE 6
END`;

export default async function TranscodeJobsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);

  const sp = await searchParams;
  const filter = resolveFilter(sp.filter);

  // Audit the surface view itself — DLQ inspection is a programme-admin
  // oversight tool, same as /admin/whatsapp-log.
  void recordAudit({
    action: "transcode.dlq.surface_viewed",
    entityType: "transcode_job",
    metadata: { filter },
  });

  // Build the WHERE clause from the filter pill. 'all' returns
  // everything; the other branches map to specific status sets or
  // time windows.
  const conds: SQL[] = [];
  if (filter === "failed") {
    conds.push(eq(transcodeJobs.status, "failed"));
  } else if (filter === "in_progress") {
    conds.push(eq(transcodeJobs.status, "running"));
  } else if (filter === "queued") {
    conds.push(eq(transcodeJobs.status, "queued"));
  } else if (filter === "recent") {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    conds.push(gte(transcodeJobs.createdAt, twentyFourHoursAgo));
  }

  // Single round-trip join: transcode_jobs joins to its parent
  // video_submission (for source + the deep-link target). When the
  // filter pill is 'all', conds is empty and `and(...conds)` evaluates
  // to undefined — drizzle's where() accepts that as a no-op.
  const rows = await db
    .select({
      jobId: transcodeJobs.id,
      videoSubmissionId: transcodeJobs.videoSubmissionId,
      status: transcodeJobs.status,
      error: transcodeJobs.error,
      profile: transcodeJobs.profile,
      bullJobId: transcodeJobs.bullJobId,
      startedAt: transcodeJobs.startedAt,
      endedAt: transcodeJobs.endedAt,
      createdAt: transcodeJobs.createdAt,
      source: videoSubmissions.source,
    })
    .from(transcodeJobs)
    .innerJoin(
      videoSubmissions,
      eq(transcodeJobs.videoSubmissionId, videoSubmissions.id),
    )
    .where(conds.length === 0 ? undefined : and(...conds))
    .orderBy(STATUS_SORT_ORDER, desc(transcodeJobs.createdAt))
    .limit(PAGE_LIMIT);

  // attempts per video_submission — counts how many transcode_jobs rows
  // exist for the same submission. Operators read this to see "we've
  // already retried this thing 4 times" before clicking Retry again.
  const submissionIds = Array.from(
    new Set(rows.map((r) => r.videoSubmissionId)),
  );
  const attemptsBySubmission = new Map<string, number>();
  if (submissionIds.length > 0) {
    const attemptRows = await db
      .select({
        videoSubmissionId: transcodeJobs.videoSubmissionId,
        count: sql<number>`count(*)::int`,
      })
      .from(transcodeJobs)
      .where(inArray(transcodeJobs.videoSubmissionId, submissionIds))
      .groupBy(transcodeJobs.videoSubmissionId);
    for (const a of attemptRows) {
      attemptsBySubmission.set(a.videoSubmissionId, a.count);
    }
  }

  const depth = await loadDlqDepth();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Transcode jobs</h1>
        <p className="text-sm text-neutral-500">
          Inspect and operate the ffmpeg → HLS 480p pipeline. Failed
          rows are listed first; click Retry to re-enqueue a job onto
          BullMQ, or Drop to bury it without retry. Every action is
          logged to the audit trail.
        </p>
      </header>

      <section
        aria-label="BullMQ queue depth"
        className="rounded-lg border border-neutral-200 bg-white p-3 text-sm"
        data-testid="dlq-depth-strip"
      >
        {depth === null ? (
          <span className="text-neutral-500">
            Live queue depth unavailable (Redis unreachable).
          </span>
        ) : (
          <dl className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1">
              <dt className="font-medium text-neutral-500">Waiting</dt>
              <dd className="font-mono">{depth.waiting}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="font-medium text-neutral-500">Active</dt>
              <dd className="font-mono">{depth.active}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="font-medium text-neutral-500">Delayed</dt>
              <dd className="font-mono">{depth.delayed}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="font-medium text-rust">Failed (DLQ)</dt>
              <dd className="font-mono font-semibold">{depth.failed}</dd>
            </div>
          </dl>
        )}
      </section>

      <nav
        aria-label="Filter transcode jobs"
        className="flex flex-wrap gap-2"
        data-testid="dlq-filter-pills"
      >
        {FILTERS.map((f) => {
          const active = filter === f;
          const href = f === "all" ? "/admin/transcode-jobs" : `/admin/transcode-jobs?filter=${f}`;
          return (
            <Link
              key={f}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs ${
                active
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
              aria-current={active ? "page" : undefined}
            >
              {FILTER_LABELS[f]}
            </Link>
          );
        })}
      </nav>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Submission</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Error</th>
              <th className="px-3 py-2">Attempts</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                  No transcode jobs match the current filter.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const canRetry = r.status === "failed";
                const canDrop = r.status === "failed";
                const errorShort = (r.error ?? "").trim();
                const errorPreview =
                  errorShort.length > 60 ? `${errorShort.slice(0, 60)}…` : errorShort || "—";
                const attempts = attemptsBySubmission.get(r.videoSubmissionId) ?? 1;
                const updated = r.endedAt ?? r.startedAt ?? r.createdAt;
                return (
                  <tr key={r.jobId} className="border-t border-neutral-100">
                    <td className="px-3 py-2 text-xs">
                      <span className={STATUS_CHIP[r.status] ?? "chip"}>{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <Link
                        href={`/videos/${r.videoSubmissionId}`}
                        className="font-mono text-neutral-700 underline hover:text-neutral-900"
                      >
                        {r.videoSubmissionId.slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="chip">{r.source}</span>
                    </td>
                    <td className="px-3 py-2 text-xs" title={errorShort}>
                      {errorPreview}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{attempts}</td>
                    <td className="px-3 py-2 text-xs">
                      {updated?.toISOString().slice(0, 19).replace("T", " ") ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {canRetry ? (
                          <form action={retryTranscodeJobAction}>
                            <input type="hidden" name="jobId" value={r.jobId} />
                            <button
                              type="submit"
                              className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50"
                              data-testid="dlq-retry-button"
                            >
                              Retry
                            </button>
                          </form>
                        ) : null}
                        {canDrop ? (
                          <form action={dropTranscodeJobAction}>
                            <input type="hidden" name="jobId" value={r.jobId} />
                            <button
                              type="submit"
                              className="rounded-md border border-rust px-2 py-1 text-xs text-rust hover:bg-neutral-50"
                              data-testid="dlq-drop-button"
                            >
                              Drop
                            </button>
                          </form>
                        ) : null}
                        {!canRetry && !canDrop ? (
                          <span className="text-neutral-400">—</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-400">
        Showing the most recent {PAGE_LIMIT} transcode jobs. Errors are
        truncated to 60 characters; hover to see the full text. For the
        full audit history (retries, drops, worker errors) see{" "}
        <Link href="/admin/audit" className="underline">
          /admin/audit
        </Link>
        .
      </p>
    </main>
  );
}

