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

test("spec 162 — page renders BullMQ live depth via getJobCounts", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /from\s+"@gml\/worker\/queues"/,
    "page must import transcodeQueue from @gml/worker/queues",
  );
  assert.match(
    src,
    /transcodeQueue\.getJobCounts\(/,
    "page must call transcodeQueue.getJobCounts to surface live depth",
  );
  // The depth must cover at least the four states the spec calls out.
  assert.match(src, /"waiting"/, "depth strip must read the 'waiting' state");
  assert.match(src, /"active"/, "depth strip must read the 'active' state");
  assert.match(src, /"failed"/, "depth strip must read the 'failed' (DLQ) state");
  assert.match(src, /"delayed"/, "depth strip must read the 'delayed' state");
  // try/catch ensures Redis-down doesn't break the page.
  assert.match(
    src,
    /loadDlqDepth/,
    "page must lift the getJobCounts call into a named helper for the try/catch wrap",
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
  const src = read(PAGE_PATH);
  // The conditional gate must be the literal status check 'failed'.
  assert.match(
    src,
    /canRetry\s*=\s*r\.status\s*===\s*"failed"/,
    "Retry button must be conditional on row.status === 'failed'",
  );
  assert.match(
    src,
    /canDrop\s*=\s*r\.status\s*===\s*"failed"/,
    "Drop button must be conditional on row.status === 'failed'",
  );
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
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /from\s+"@gml\/worker\/queues"/,
    "actions.ts must import transcodeQueue from @gml/worker/queues",
  );
  assert.match(
    src,
    /transcodeQueue\.add\(/,
    "retry action must call transcodeQueue.add to enqueue the re-encode",
  );
  // All five payload fields must appear (same shape as the webhook).
  assert.match(src, /videoSubmissionId:/, "transcodeQueue payload must include videoSubmissionId");
  assert.match(src, /fileId:/, "transcodeQueue payload must include fileId");
  assert.match(src, /bucket:/, "transcodeQueue payload must include bucket");
  assert.match(src, /objectKey:/, "transcodeQueue payload must include objectKey");
  assert.match(src, /source:\s*row\.source/, "transcodeQueue payload must carry the parent submission's source");
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
  // The drop action MUST NOT call transcodeQueue.add — that's the
  // load-bearing semantic difference vs retry. We assert the substring
  // appears at most ONCE in the file (in retry, not in drop).
  const enqueueMatches = src.match(/transcodeQueue\.add\(/g) ?? [];
  assert.equal(
    enqueueMatches.length,
    1,
    "transcodeQueue.add must be called exactly once (in retry) — drop must NOT re-enqueue",
  );
});

test("spec 162 — both actions validate row.jobStatus === 'failed' before mutating", () => {
  const src = read(ACTIONS_PATH);
  // Both actions reject non-failed rows with a redirect carrying an error.
  assert.match(
    src,
    /not_retriable_status/,
    "retry action must reject non-failed rows with error=not_retriable_status",
  );
  assert.match(
    src,
    /not_droppable_status/,
    "drop action must reject non-failed rows with error=not_droppable_status",
  );
  const statusGuardMatches = src.match(/row\.jobStatus\s*!==\s*"failed"/g) ?? [];
  assert.ok(
    statusGuardMatches.length >= 2,
    "both actions must each guard on row.jobStatus !== 'failed' — defence in depth",
  );
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
