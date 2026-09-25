import "server-only";

// What an operator may do from a /admin/transcode-jobs row, decided from the
// SUBMISSION's current state -- one rule, shared by the page (which buttons to
// render) and by the actions (what to accept), so they cannot disagree.
//
// ── WHY NOT THE ROW'S OWN STATUS ────────────────────────────────────────────
//
// The worker writes one transcode_jobs row PER ATTEMPT. A video whose first
// attempt failed and whose automatic retry succeeded keeps that 'failed' row
// forever, and the page sorts failed rows first. Retry and Drop used to be
// offered -- and accepted -- on any row whose own status was 'failed', then
// wrote the submission unconditionally: Drop turned a ready, playable video
// into 'failed' (the playlist route then refuses it, and for a direct upload
// nothing in the product can undo that), and Retry un-readied it and
// transcoded it again.
//
// So a verb is offered only on a submission's LATEST attempt, only while the
// submission is actually failed, and only when no job for it is live -- except
// that Drop also applies while a retry is merely queued, and cancels it. The
// actions re-check this under a row lock and write with compare-and-set.

import { and, eq, inArray, sql } from "drizzle-orm";
import { transcodeJobs, videoSubmissions } from "@gml/db/schema";

type Reader = Pick<typeof import("@gml/db")["db"], "select" | "execute">;

export type SubmissionState = {
  status: string;
  /** The newest ledger row for the submission. */
  latestAttemptId: string | null;
  /** A job for it in the queue right now, if any. */
  liveJob: "queued" | "running" | null;
};

export type DlqVerbs = { retry: boolean; drop: boolean };

export function verbsFor(
  row: { jobId: string; status: string },
  state: SubmissionState | undefined,
): DlqVerbs {
  if (!(row.status === "failed" && state !== undefined && state.latestAttemptId === row.jobId)) {
    return { retry: false, drop: false };
  }
  return {
    // Nothing to retry while a job for it is queued or running.
    retry: state.status === "failed" && state.liveJob === null,
    // Drop also applies while a retry is merely QUEUED (the video is 'queued'
    // then, see transcode480p) -- and cancels it; it used to leave it queued, so
    // the retry ran anyway and undid the operator's decision within seconds.
    // Never while one is RUNNING: that attempt writes its own outcome.
    drop: (state.status === "failed" || state.status === "queued") && state.liveJob !== "running",
  };
}

/**
 * Cancel the retry the queue is holding for a submission. False when there is
 * none left to cancel -- a worker claimed it in the meantime, so it is running.
 */
export async function cancelQueuedRetry(
  q: Pick<typeof import("@gml/db")["db"], "execute">,
  submissionId: string,
): Promise<boolean> {
  const res = await q.execute(sql`
    UPDATE jobs
       SET status = 'dead', completed_at = now(), updated_at = now(),
           last_error = COALESCE(last_error, '') || ' [dropped by an operator]'
     WHERE queue = 'transcode' AND dedupe_key = ${`submission:${submissionId}`} AND status = 'queued'
     RETURNING id
  `);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

/** Why a verb was refused, as the page's ?error= code. */
export function refusalFor(row: { jobId: string; status: string }, state: SubmissionState | undefined): string {
  if (row.status !== "failed") return "not_failed_attempt";
  if (!state || state.latestAttemptId !== row.jobId) return "not_latest_attempt";
  if (state.liveJob !== null) return "job_live";
  return "submission_not_failed";
}

/**
 * The state of each submission. `forUpdate` locks the submission rows, for an
 * action that is about to write them.
 */
export async function loadSubmissionStates(
  q: Reader,
  submissionIds: string[],
  opts: { forUpdate?: boolean } = {},
): Promise<Map<string, SubmissionState>> {
  const out = new Map<string, SubmissionState>();
  if (submissionIds.length === 0) return out;

  const base = q
    .select({ id: videoSubmissions.id, status: videoSubmissions.status })
    .from(videoSubmissions)
    .where(inArray(videoSubmissions.id, submissionIds));
  const subs = opts.forUpdate ? await base.for("update") : await base;

  const latest = await q.execute<{ video_submission_id: string; id: string }>(sql`
    SELECT DISTINCT ON (${transcodeJobs.videoSubmissionId}) ${transcodeJobs.videoSubmissionId} AS video_submission_id, ${transcodeJobs.id} AS id
      FROM ${transcodeJobs}
     WHERE ${inArray(transcodeJobs.videoSubmissionId, submissionIds)}
     ORDER BY ${transcodeJobs.videoSubmissionId}, ${transcodeJobs.createdAt} DESC, ${transcodeJobs.id} DESC
  `);
  const latestBy = new Map(
    ((latest as unknown as { rows: { video_submission_id: string; id: string }[] }).rows ?? []).map((r) => [
      r.video_submission_id,
      r.id,
    ]),
  );

  // Every transcode producer enqueues with the dedupe key submission:<id>.
  const keys = submissionIds.map((id) => `submission:${id}`);
  const live = await q.execute<{ dedupe_key: string; status: string }>(sql`
    SELECT dedupe_key, status FROM jobs
     WHERE queue = 'transcode' AND status IN ('queued', 'running')
       AND dedupe_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
  `);
  const liveBy = new Map<string, "queued" | "running">();
  for (const r of (live as unknown as { rows: { dedupe_key: string; status: string }[] }).rows ?? []) {
    const id = r.dedupe_key.slice("submission:".length);
    // 'running' wins: it is the one that cannot be interrupted.
    if (liveBy.get(id) !== "running") liveBy.set(id, r.status as "queued" | "running");
  }

  for (const s of subs) {
    out.set(s.id, {
      status: s.status,
      latestAttemptId: latestBy.get(s.id) ?? null,
      liveJob: liveBy.get(s.id) ?? null,
    });
  }
  return out;
}

/** Compare-and-set a submission's status; true when it was in `from`. */
export async function moveSubmission(
  q: Pick<typeof import("@gml/db")["db"], "update">,
  id: string,
  from: Array<"failed" | "queued">,
  to: "failed" | "queued",
): Promise<boolean> {
  const rows = await q
    .update(videoSubmissions)
    .set({ status: to })
    .where(and(eq(videoSubmissions.id, id), inArray(videoSubmissions.status, from)))
    .returning({ id: videoSubmissions.id });
  return rows.length > 0;
}
