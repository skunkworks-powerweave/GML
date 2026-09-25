// Governance test for spec 162 — Transcode DLQ admin view
// (Workflow Run 15 audit-closure MISS).
//
// Files under audit:
//
//   1. apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx
//      (CREATED) — server component, programme_admin + super_admin gate,
//      transcodeQueue.getJobCounts top strip, URL-driven filter pills,
//      transcode_jobs ⨝ video_submissions table, Retry + Drop forms.
//   2. apps/web/src/app/(authenticated)/admin/transcode-jobs/actions.ts
//      (CREATED) — "use server", retryTranscodeJobAction +
//      dropTranscodeJobAction, both gated, audited.
//   3. packages/db/src/schema/videos.ts (EDITED) —
//      transcode_jobs_status_check widened to include 'dropped'.
//   4. packages/db/src/migrations/0021_transcode_jobs_dropped_status.sql
//      (CREATED) — DROP + ADD CONSTRAINT to align the DB with the schema.
//   5. apps/web/src/app/(authenticated)/admin/page.tsx (EDITED) —
//      System-section link to /admin/transcode-jobs.
//
// Plus the five spec-kit files under specs/162-transcode-dlq-admin-view/.
//
// PARTIALLY INVERTED. The surface, its role gate, its filters, its audit rows
// and the retry/drop semantics are all unchanged. Three assertions pinned the
// BullMQ side of the page -- getJobCounts for the live-depth strip, and
// transcodeQueue.add in the retry action -- and BullMQ is gone, replaced by a
// `jobs` table in the same Postgres database as the transcode_jobs ledger this
// page renders. Each of those three now pins the Postgres equivalent, and the
// reasoning is inline at each one. The two tables stay deliberately separate:
// transcode_jobs is the per-attempt DOMAIN record, jobs is the TRANSPORT.
// Conflating them is what left `bull_job_id` on transcode_jobs as a column four
// files read and nothing ever wrote.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx";
const ACTIONS_PATH = "apps/web/src/app/(authenticated)/admin/transcode-jobs/actions.ts";
const SCHEMA_PATH = "packages/db/src/schema/videos.ts";
const MIGRATION_PATH = "packages/db/src/migrations/0021_transcode_jobs_dropped_status.sql";
const ADMIN_INDEX = "apps/web/src/app/(authenticated)/admin/page.tsx";
const SPEC_DIR = "specs/162-transcode-dlq-admin-view";

// ---------- Spec-kit + plan.md contract ----------

test("spec 162 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the transcode DLQ admin view spec`,
    );
  }
});

test("spec 162 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /admin\/transcode-jobs\/page\.tsx/,
    "plan.md must call out the new admin page in CREATED",
  );
  assert.match(
    src,
    /admin\/transcode-jobs\/actions\.ts/,
    "plan.md must call out the new server-actions file in CREATED",
  );
  assert.match(
    src,
    /0021_transcode_jobs_dropped_status/,
    "plan.md must declare the new migration in CREATED + MIGRATED",
  );
  assert.match(
    src,
    /schema\/videos\.ts/,
    "plan.md must call out the schema edit in EDITED",
  );
});

// ---------- Page contract ----------

test("spec 162 — /admin/transcode-jobs/page.tsx exists and is a server component", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  const src = read(PAGE_PATH);
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "DLQ admin page must stay a server component — Retry/Drop use server actions, not client handlers",
  );
  assert.match(
    src,
    /export const dynamic\s*=\s*"force-dynamic"/,
    "page must opt out of caching so freshly-failed jobs surface immediately",
  );
});

test("spec 162 — page calls requireRole with programme_admin + super_admin", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/lib\/guards"/, "page must import requireRole from @/lib/guards");
  const m = src.match(/requireRole\(\s*\[([^\]]*)\]/);
  assert.ok(m, "page must call requireRole with a role list");
  const list = m[1];
  assert.match(list, /"programme_admin"/, "role list must include programme_admin");
  assert.match(list, /"super_admin"/, "role list must include super_admin");
  assert.doesNotMatch(list, /"teacher"/, "teacher must not be in the role list");
  assert.doesNotMatch(list, /"observer"/, "observer must not be in the role list");
  assert.doesNotMatch(list, /"mentor"/, "mentor must not be in the role list");
});

test("spec 162 — page queries transcode_jobs joined to video_submissions", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\(transcodeJobs\)/, "must select from transcodeJobs table");
  assert.match(
    src,
    /innerJoin\(\s*videoSubmissions/,
    "must join transcode_jobs to video_submissions so the table can show source + deep-link",
  );
  assert.match(
    src,
    /desc\(transcodeJobs\.createdAt\)/,
    "must order rows by createdAt DESC inside each status bucket",
  );
  assert.match(
    src,
    /\.limit\(\s*(100|PAGE_LIMIT)\s*\)/,
    "must cap the surface at 100 rows",
  );
});

test("spec 162 — page renders live queue depth from Postgres, not from BullMQ", () => {
  // INVERTED. This required `transcodeQueue.getJobCounts(...)` imported from
  // "@gml/worker/queues", plus the four BullMQ state names as string literals.
  //
  // What spec 162 was actually buying survives whole: an operator opening the
  // DLQ page sees the LIVE queue alongside the historical transcode_jobs table,
  // so they can tell "the queue is backed up" from "the queue is empty and
  // these rows are stale". The old header comment beside this code explains why
  // both views were needed -- the DB and Redis could drift, and "a Redis flush
  // left rows in the DB with no live queue entry" was a real triage scenario.
  //
  // That drift was itself a symptom. Two independent stores each held half the
  // truth about a job, neither could be joined to the other, and reconciling
  // them was the operator's problem. With the queue in the same database as the
  // ledger, the depth is a GROUP BY and the divergence class is gone. The two
  // TABLES remain deliberately distinct -- `transcode_jobs` is the per-attempt
  // domain ledger this page renders, `jobs` is the transport -- but they are
  // now consistent by construction rather than by luck.
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /import\s*\{\s*transcodeQueueDepthOrNull\s*\}\s*from\s*"@\/lib\/queue"/,
    "page must import transcodeQueueDepthOrNull from @/lib/queue",
  );
  assert.match(
    src,
    /loadDlqDepth/,
    "page must lift the depth read into a named helper so the failure path stays in one place",
  );
  // ...and specifically the OrNull variant. The topbar chip swallows errors and
  // shows zeros because it is decoration; this page must not, because zeros
  // here are a claim ("nothing is queued") an operator will act on. The
  // distinction is the reason two helpers exist.
  assert.match(
    src,
    /await\s+transcodeQueueDepthOrNull\(\)/,
    "the admin view must use the variant that can report 'unavailable' rather than zero",
  );
  assert.match(
    src,
    /if\s*\(!counts\)\s*return null/,
    "an unavailable depth must propagate as null so the page can render its banner",
  );

  // The strip's vocabulary is preserved, as a mapping from the new statuses.
  assert.match(src, /waiting:\s*counts\.queued/, "'waiting' must map to queued");
  assert.match(src, /active:\s*counts\.running/, "'active' must map to running");
  assert.match(
    src,
    /failed:\s*counts\.dead/,
    "'failed' must map to `dead` -- exhausted attempts, i.e. the jobs that need a person",
  );
  // 'delayed' was BullMQ's name for a job waiting out its backoff. There is no
  // such state now: a retry is a queued row with run_at in the future, already
  // counted as waiting. Pinned at zero rather than removed so the strip's shape
  // stays stable, and so this comment survives next to the reason.
  assert.match(
    src,
    /delayed:\s*0/,
    "'delayed' has no successor state -- a backed-off retry is simply a queued job with a future run_at",
  );

  const stripped = read(PAGE_PATH)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/getJobCounts|@gml\/worker/.test(stripped),
    "the page must not reach into the worker package or call getJobCounts",
  );
});

test("spec 162 — page renders the five filter pills as URL-driven Links", () => {
  const src = read(PAGE_PATH);
  // The five filter keys must all appear as literal strings in the
  // FILTERS array (the labels are derived from the keys, not from
  // free-form display strings).
  assert.match(src, /"all"/, "filter set must include 'all'");
  assert.match(src, /"failed"/, "filter set must include 'failed'");
  assert.match(src, /"in_progress"/, "filter set must include 'in_progress'");
  assert.match(src, /"queued"/, "filter set must include 'queued'");
  assert.match(src, /"recent"/, "filter set must include 'recent'");
  // The pills must render as Next.js Links (URL-driven, not client state).
  assert.match(
    src,
    /import\s+Link\s+from\s+"next\/link"/,
    "page must import Link from next/link for the filter pills",
  );
  assert.match(
    src,
    /\/admin\/transcode-jobs\?filter=/,
    "filter pills must drive the filter via ?filter= search param",
  );
  // aria-current marks the active pill for screen readers.
  assert.match(
    src,
    /aria-current=/,
    "active pill must declare aria-current for screen-reader accessibility",
  );
});

test("spec 162 — page renders Retry + Drop buttons wired to server actions", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /from\s+"\.\/actions"/,
    "page must import from co-located ./actions module",
  );
  assert.match(
    src,
    /retryTranscodeJobAction/,
    "page must reference the retryTranscodeJobAction export",
  );
  assert.match(
    src,
    /dropTranscodeJobAction/,
    "page must reference the dropTranscodeJobAction export",
  );
  assert.match(
    src,
    /action=\{retryTranscodeJobAction\}/,
    "page must bind the Retry form to the server action (no client onClick)",
  );
  assert.match(
    src,
    /action=\{dropTranscodeJobAction\}/,
    "page must bind the Drop form to the server action (no client onClick)",
  );
  assert.match(
    src,
    /name="jobId"/,
    "both forms must POST a jobId hidden input so the actions know which row to act on",
  );
});

test("spec 162 — page restricts Retry + Drop to failed rows only", () => {
  // CORRECTED (F63). This pinned `canRetry = r.status === "failed"` -- the row's
  // OWN status alone -- and that was the defect: the worker writes one row per
  // attempt, so the old failed attempt of a video that a later attempt made
  // ready still qualified, and Drop on it broke a playable video. The gate is
  // now shared with the actions (./state.ts) and requires, beyond a failed row,
  // that it is the submission's latest attempt, that the submission is failed,
  // and that nothing is live for it. tests/behaviour/dlq-actions.test.ts
  // executes this; the regexes pin the shape.
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /\{\s*retry:\s*canRetry,\s*drop:\s*canDrop\s*\}\s*=\s*verbsFor\(r,\s*state\)/,
    "Retry/Drop must come from the shared verbsFor() rule",
  );
  const state = read(PAGE_PATH.replace(/page\.tsx$/, "state.ts"));
  for (const [re, what] of [
    [/row\.status\s*===\s*"failed"/, "a failed attempt row"],
    [/state\.latestAttemptId\s*===\s*row\.jobId/, "the submission's latest attempt"],
    [/state\.status\s*===\s*"failed"/, "a submission that is failed now"],
    [/state\.liveJob\s*===\s*null/, "no queued or running job for it"],
  ]) {
    assert.match(state, re, `verbsFor() must require ${what}`);
  }
});

test("spec 162 — page audits the surface view itself", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/, "page must import recordAudit from @/lib/audit");
  assert.match(
    src,
    /transcode\.dlq\.surface_viewed/,
    "page must record a 'transcode.dlq.surface_viewed' audit row on each render",
  );
});

// ---------- Actions contract ----------

test("spec 162 — actions.ts exists and declares use-server", () => {
  assert.ok(existsSync(resolve(root, ACTIONS_PATH)), `${ACTIONS_PATH} must exist`);
  const src = read(ACTIONS_PATH);
  assert.match(src, /^\s*"use server"/m, "actions.ts must declare 'use server' at the top of the file");
});

test("spec 162 — actions.ts exports both Retry + Drop with the correct shape", () => {
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /export async function retryTranscodeJobAction/,
    "actions.ts must export an async retryTranscodeJobAction function",
  );
  assert.match(
    src,
    /export async function dropTranscodeJobAction/,
    "actions.ts must export an async dropTranscodeJobAction function",
  );
  // Same role gate as the page — defence in depth, run twice in the file.
  const requireRoleMatches = src.match(/requireRole\(/g) ?? [];
  assert.ok(
    requireRoleMatches.length >= 2,
    "both Retry and Drop actions must each call requireRole — defence in depth",
  );
  assert.match(
    src,
    /requireRole\(\s*\[\s*"programme_admin",\s*"super_admin"\s*\]\s*\)/,
    "actions must gate on programme_admin + super_admin",
  );
  assert.match(
    src,
    /formData\.get\(\s*"jobId"\s*\)/,
    "actions must read jobId from formData (matches the hidden input on the page)",
  );
});

test("spec 162 — retryTranscodeJobAction re-enqueues with the webhook payload shape", () => {
  // INVERTED on the transport and on one payload field.
  //
  // The transport: `transcodeQueue.add` from "@gml/worker/queues" becomes
  // `enqueueTranscode` from "@/lib/queue". Same guarantee as before -- the
  // operator's Retry produces a job indistinguishable from the one the webhook
  // produces, so it exercises the same code path rather than a special one.
  //
  // The field: `source: row.source` is gone. The worker used it to pick a
  // `-c copy` stream-copy shortcut for WhatsApp video; that failed outright on
  // non-Annex-B H.264 or non-AAC audio from arbitrary phone cameras, and when
  // it worked it preserved a multi-megabit stream on the low-bandwidth path.
  // Every source is re-encoded now, so a retry must not be able to carry a flag
  // that would make it behave differently from a first attempt.
  //
  // A NOTE ON WHY RETRY STILL WORKS AT ALL. enqueueTranscode dedupes on
  // `submission:<id>`, and a plain unique index on that key would make this
  // button dead forever after the first attempt. The index is PARTIAL --
  // `WHERE dedupe_key IS NOT NULL AND status IN ('queued','running')` -- so a
  // duplicate while a job is pending is absorbed and a deliberate re-run after
  // it finishes is allowed. This is the same mistake, avoided, that the plain
  // INSERT against files_bucket_objectkey_uq made: that one turned transcode
  // attempts 2 and 3 into failures by construction.
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /import\s*\{\s*enqueueTranscode\s*\}\s*from\s*"@\/lib\/queue"/,
    "actions.ts must import enqueueTranscode from @/lib/queue",
  );
  const call = src.match(/enqueueTranscode\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(call, "retry action must call enqueueTranscode({ ... }) to re-enqueue the re-encode");
  const payload = call[1];
  for (const field of ["videoSubmissionId", "fileId", "bucket", "objectKey"]) {
    assert.match(payload, new RegExp(`\\b${field}\\s*[:,}]`), `payload must include ${field}`);
  }
  assert.ok(
    !/\bsource\b/.test(payload),
    "the retry payload must not carry the submission's source -- a retry must be " +
      "byte-for-byte the same job a first attempt would have been",
  );
  // The provenance still belongs on the audit row, which records what an
  // operator did rather than instructing the worker.
  assert.match(
    src,
    /source:\s*row\.source/,
    "the audit metadata must still record the submission's source for traceability",
  );
});

test("spec 162 — retryTranscodeJobAction audits transcode.retry_requested", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/, "actions.ts must import recordAudit");
  assert.match(
    src,
    /action:\s*"transcode\.retry_requested"/,
    "retry action must use the dotted audit verb 'transcode.retry_requested'",
  );
  assert.match(
    src,
    /previousStatus/,
    "audit metadata must carry previousStatus so the audit row explains the row state at retry time",
  );
});

test("spec 162 — dropTranscodeJobAction marks status='dropped' and audits", () => {
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /set\(\s*\{\s*status:\s*"dropped"/,
    "drop action must update transcode_jobs.status to 'dropped'",
  );
  assert.match(
    src,
    /action:\s*"transcode\.dropped"/,
    "drop action must use the dotted audit verb 'transcode.dropped'",
  );
  // The drop action MUST NOT enqueue — that is the load-bearing semantic
  // difference vs retry, and it is why the count, not merely the presence, is
  // asserted. Unchanged in intent; only the name of the enqueue call moved,
  // from `transcodeQueue.add(` to `enqueueTranscode(`.
  const enqueueMatches = src.match(/enqueueTranscode\(/g) ?? [];
  assert.equal(
    enqueueMatches.length,
    1,
    "enqueueTranscode must be called exactly once (in retry) — drop must NOT re-enqueue",
  );
});

test("spec 162 — both actions validate row.jobStatus === 'failed' before mutating", () => {
  // CORRECTED (F63). This pinned a bare `row.jobStatus !== "failed"` guard in
  // each action, which is the check that let a stale failed attempt through
  // (see the page test above). Both actions now re-check the shared rule
  // against state loaded under a lock on the submission, inside the
  // transaction that writes it, and report a refusal with an ?error= code.
  const src = read(ACTIONS_PATH);
  const guards = src.match(/verbsFor\([^)]*\)\.(retry|drop)/g) ?? [];
  assert.ok(guards.length >= 2, "both actions must each check verbsFor() before mutating — defence in depth");
  const locked = src.match(/loadSubmissionStates\(tx,[^)]*forUpdate:\s*true/g) ?? [];
  assert.ok(locked.length >= 2, "both actions must read the submission's state under a row lock, in their transaction");
  const refused = src.match(/redirect\(`\$\{DLQ_PATH\}\?error=\$\{refusal\}`\)/g) ?? [];
  assert.ok(refused.length >= 2, "both actions must redirect a refusal back with its error code");
  // Every code refusalFor() can return has a message on the page.
  const page = read(PAGE_PATH);
  for (const code of ["not_failed_attempt", "not_latest_attempt", "job_live", "submission_not_failed"]) {
    assert.match(page, new RegExp(`${code}:`), `the page must explain ?error=${code}`);
  }
});

test("spec 162 — both actions revalidate + redirect back to /admin/transcode-jobs", () => {
  const src = read(ACTIONS_PATH);
  const revalidateMatches = src.match(/revalidatePath\(/g) ?? [];
  const redirectMatches = src.match(/redirect\(/g) ?? [];
  assert.ok(
    revalidateMatches.length >= 2,
    "both actions must call revalidatePath so the page rerenders with fresh state",
  );
  // /admin/transcode-jobs must appear as the redirect target.
  assert.match(
    src,
    /\/admin\/transcode-jobs/,
    "redirect target must be /admin/transcode-jobs so the operator stays in context",
  );
  assert.ok(
    redirectMatches.length >= 2,
    "both actions must redirect after mutating (server action contract)",
  );
});

// ---------- Schema + migration contract ----------

test("spec 162 — schema CHECK widened to accept 'dropped'", () => {
  const src = read(SCHEMA_PATH);
  // The constraint name stays the same; the VALUE widens.
  const m = src.match(
    /transcode_jobs_status_check[^]*?sql`\$\{t\.status\}\s*IN\s*\(([^)]+)\)/,
  );
  assert.ok(m, "transcode_jobs_status_check declaration must be present");
  const body = m[1];
  assert.match(body, /'queued'/, "CHECK must still accept 'queued'");
  assert.match(body, /'running'/, "CHECK must still accept 'running'");
  assert.match(body, /'succeeded'/, "CHECK must still accept 'succeeded'");
  assert.match(body, /'failed'/, "CHECK must still accept 'failed'");
  assert.match(body, /'cancelled'/, "CHECK must still accept 'cancelled'");
  assert.match(body, /'dropped'/, "CHECK must now accept 'dropped' (spec 162)");
});

test("spec 162 — migration 0021 file exists with the DROP + ADD CONSTRAINT sequence", () => {
  assert.ok(
    existsSync(resolve(root, MIGRATION_PATH)),
    `${MIGRATION_PATH} must exist for the dropped-status migration`,
  );
  const src = read(MIGRATION_PATH);
  assert.match(
    src,
    /DROP CONSTRAINT "transcode_jobs_status_check"/,
    "migration must DROP the existing CHECK constraint",
  );
  assert.match(
    src,
    /ADD CONSTRAINT[\s\S]*"transcode_jobs_status_check"/,
    "migration must re-ADD the CHECK constraint with the widened set",
  );
  assert.match(
    src,
    /'dropped'/,
    "migration must include 'dropped' in the new CHECK set",
  );
  // The migration must include all six values in the widened set.
  for (const v of ["queued", "running", "succeeded", "failed", "cancelled", "dropped"]) {
    assert.match(
      src,
      new RegExp(`'${v}'`),
      `migration's widened CHECK must include '${v}'`,
    );
  }
});

// ---------- Admin index integration ----------

test("spec 162 — /admin index page links to /admin/transcode-jobs", () => {
  const src = read(ADMIN_INDEX);
  assert.match(
    src,
    /href="\/admin\/transcode-jobs"/,
    "admin index must link to /admin/transcode-jobs so operators can navigate to the DLQ surface",
  );
  // The label must read meaningfully (not generic "Page X" boilerplate).
  assert.match(
    src,
    />\s*Transcode jobs\s*</,
    "admin index link must display the label 'Transcode jobs'",
  );
});

// ---------- Hygiene ----------

test("spec 162 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [PAGE_PATH, ACTIONS_PATH, MIGRATION_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
