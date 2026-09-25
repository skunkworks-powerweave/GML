// /admin/transcode-jobs — Transcode DLQ admin surface (Workflow Run 15
// audit-closure MISS: failed transcode jobs land in the dead-letter queue with
// no operator UI to inspect or retry them).
//
// Spec 162 ships the DB-backed inspection view + a pair of operator
// verbs (Retry, Drop) that map onto the real queue and the
// transcode_jobs table. The same role gate as /admin/whatsapp-log
// (programme_admin + super_admin) — the DLQ is a programme-oversight
// surface, not a teacher-facing tool.
//
// Surface shape:
//
//   - Top strip: live transcode queue depth (waiting / active / failed /
//     delayed) pulled via transcodeQueue.getJobCounts. The TS schema
//     and the job queue can drift — failed-in-ledger and failed-in-queue
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
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { transcodeJobs, videoSubmissions } from "@gml/db/schema";
import { deadJobs, transcodeQueueDepthOrNull, type DeadJob } from "@/lib/queue";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { lookupOwn } from "@/lib/lookup";
import { retryTranscodeJobAction, dropTranscodeJobAction } from "./actions";
import { loadSubmissionStates, verbsFor } from "./state";

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

// The four "live" queue states we surface at the top. delayed is
// included because failures back off exponentially (1 min, 10 min, 1 h)
// and a job between attempts shows up as 'delayed' — the operator
// needs to see that depth too or they'll mistake delayed jobs for
// stuck ones.
type QueueDepth = {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
};

// Spec 168 — wrap the queue-depth call in try/catch and surface
// a Redis-down banner above the historical table. The existing code already
// returned null on error; this spec makes the failure visible with an
// explicit banner ABOVE the depth strip rather than hiding the failure
// inside a "depth unavailable" hint in the strip itself. Operators
// triaging a transcode incident need to know up-front that the live
// depth is stale — the historical DB table below is still accurate.
async function loadDlqDepth(): Promise<QueueDepth | null> {
  try {
    const counts = await transcodeQueueDepthOrNull();
    if (!counts) return null;
    // 'dead' maps to the old 'failed' chip: a job that has exhausted its
    // attempts and needs a human. There is no 'delayed' state any more --
    // a retry is simply a queued job with run_at in the future, so it is
    // counted as waiting, which is what an operator actually wants to see.
    return {
      waiting: counts.queued,
      active: counts.running,
      failed: counts.dead,
      delayed: 0,
    };
  } catch (err) {
    // Redis unreachable / queue not initialised — return null so the
    // top strip shows a "depth unavailable" hint rather than misleading
    // zeros. The DB table view is still usable. Spec 168 adds a banner
    // ABOVE the table making the failure obvious.
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
  searchParams: Promise<{ filter?: string; error?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);

  const sp = await searchParams;
  const filter = resolveFilter(sp.filter);

  // RENDER THE REFUSAL. retryTranscodeJobAction and dropTranscodeJobAction both
  // redirect back here with ?error=..., and this page typed searchParams as
  // `{ filter?: string }` — so an operator who clicked Retry on a job that had
  // since succeeded was returned to an unchanged page with no message, and no
  // way to tell that from the click not registering. They would click again.
  const DLQ_ERRORS: Record<string, string> = {
    missing_job_id: "That action arrived without a job id. Try again from the table.",
    job_not_found: "That job no longer exists — it may have been pruned.",
    not_retriable_status:
      "Only a failed job can be retried. This one has since changed state; reload to see its current status.",
    not_droppable_status:
      "Only a failed job can be dropped. Reload to see its current status.",
    not_failed_attempt: "Only a failed attempt can be retried or dropped. Reload to see its current status.",
    not_latest_attempt:
      "That was an older attempt of this video. Only its latest attempt can be retried or dropped.",
    job_live: "That video already has a transcode queued or running. Reload to see its current status.",
    submission_not_failed:
      "That video is no longer failed — it has been retried or has become ready since. Reload to see it.",
  };
  const dlqError = sp.error ? lookupOwn(DLQ_ERRORS, sp.error) ?? "That action could not be completed." : null;

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
    // DB clock, not app clock -- compared against a DB timestamp column.
    conds.push(sql`${transcodeJobs.createdAt} >= now() - interval '24 hours'`);
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

  // Which rows are actionable is the SUBMISSION's call, not the row's (see
  // ./state.ts): the same rule the actions enforce.
  const states = await loadSubmissionStates(db, submissionIds);

  // What the QUEUE holds that needs a human, every queue, with the error it
  // recorded -- including jobs with no ledger row, which the table below
  // (transcode attempts) cannot show. Empty rather than failing the page.
  const dead: DeadJob[] = await deadJobs().catch((err) => {
    console.error("[transcode-jobs] deadJobs failed", err);
    return [];
  });

  const depth = await loadDlqDepth();
  // Spec 168 — explicit "Redis unreachable" flag drives the banner
  // ABOVE the table. loadDlqDepth already returns null on error; this
  // boolean is just the more readable name at the JSX site.
  const redisUnavailable = depth === null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Transcode jobs</h1>
        <p className="text-sm text-neutral-500">
          Inspect and operate the ffmpeg → HLS 480p pipeline. Failed
          rows are listed first; click Retry to re-enqueue a job onto
          the queue, or Drop to bury it without retry. Each attempt is its
          own row; only a video&apos;s latest attempt, while the video is
          failed, can be retried or dropped. Every action is logged to the
          audit trail.
        </p>
      </header>

      {dlqError ? (
        <p
          role="alert"
          data-testid="dlq-error"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          {dlqError}
        </p>
      ) : null}

      {redisUnavailable ? (
        <div
          role="alert"
          data-testid="dlq-redis-down-banner"
          className="rounded-lg border border-saffron bg-saffron-soft p-3 text-sm"
          style={{
            border: "1px solid var(--saffron)",
            background: "var(--saffron-soft)",
            color: "var(--ink-2)",
          }}
        >
          <strong>Live queue depth unavailable (the database is unreachable).</strong>{" "}
          The historical job table below is still accurate.
        </div>
      ) : null}

      <section
        aria-label="transcode queue depth"
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

      <section
        aria-label="dead jobs"
        data-testid="dlq-dead-jobs"
        className="rounded-lg border border-neutral-200 bg-white p-3 text-sm"
      >
        <h2 className="font-semibold">Dead jobs, every queue ({dead.length})</h2>
        <p className="text-xs text-neutral-500">
          Jobs whose attempts are exhausted, with the error the queue recorded. To
          retry a dead transcode, use Retry on the video&apos;s latest failed
          attempt below. A dead retention sweep runs again the next day by itself.
        </p>
        {dead.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">None.</p>
        ) : (
          <table className="mt-2 w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="py-1 pr-3">Queue</th>
                <th className="py-1 pr-3">Job</th>
                <th className="py-1 pr-3">Attempts</th>
                <th className="py-1 pr-3">Died</th>
                <th className="py-1">Last error</th>
              </tr>
            </thead>
            <tbody>
              {dead.map((j) => {
                // The verdict is at the END of an error (ffmpeg's last lines, the
                // reaper's note), so the preview shows the tail.
                const err = (j.lastError ?? "").trim();
                const tail = err.length > 120 ? `…${err.slice(-120)}` : err || "—";
                return (
                  <tr key={j.id} className="border-t border-neutral-100" data-dead-job-id={j.id}>
                    <td className="py-1 pr-3">
                      <span className="chip">{j.queue}</span>
                    </td>
                    <td className="py-1 pr-3 font-mono">
                      {j.videoSubmissionId ? (
                        <Link href={`/videos/${j.videoSubmissionId}`} className="underline">
                          {j.name} {j.videoSubmissionId.slice(0, 10)}
                        </Link>
                      ) : (
                        j.name
                      )}
                    </td>
                    <td className="py-1 pr-3 font-mono">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="py-1 pr-3">
                      {j.completedAt?.toISOString().slice(0, 19).replace("T", " ") ?? "—"}
                    </td>
                    <td className="py-1" title={err}>
                      {tail}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
              <th className="px-3 py-2">Video now</th>
              <th className="px-3 py-2">Error</th>
              <th className="px-3 py-2">Attempts</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                  No transcode jobs match the current filter.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const state = states.get(r.videoSubmissionId);
                const { retry: canRetry, drop: canDrop } = verbsFor(r, state);
                const superseded = r.status === "failed" && state?.latestAttemptId !== r.jobId;
                const errorShort = (r.error ?? "").trim();
                const errorPreview =
                  errorShort.length > 60 ? `${errorShort.slice(0, 60)}…` : errorShort || "—";
                const attempts = attemptsBySubmission.get(r.videoSubmissionId) ?? 1;
                const updated = r.endedAt ?? r.startedAt ?? r.createdAt;
                return (
                  <tr key={r.jobId} data-job-id={r.jobId} className="border-t border-neutral-100">
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
                    <td className="px-3 py-2 text-xs" data-testid="dlq-video-status">
                      {state?.status ?? "—"}
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
                          <span className="text-neutral-400">
                            {superseded ? "superseded by a later attempt" : "—"}
                          </span>
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

