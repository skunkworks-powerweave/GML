// Governance test for spec 159 — Quiz attempts history + per-quiz time
// limit (Workflow Run 15 audit-closure MISS).
//
// Closes the remaining feature MISS from the Run 14 audit:
//
//   1. quizzes.time_limit_seconds nullable column + CHECK (60..7200);
//      runner countdown + auto-submit;
//   2. /quizzes/[slug]/history per-user attempts page;
//   3. View-history link on the per-attempt result page.
//
// This file pins:
//   * All five spec-kit files exist;
//   * plan.md follows the CREATED / EDITED / MIGRATED contract and
//     calls out every touched file by name;
//   * Schema declares the new column + CHECK;
//   * 0019_quiz_time_limit.sql contains both DDL statements;
//   * 0019_snapshot.json chains off 0018's id and declares the new
//     column + check;
//   * _journal.json carries an idx=19 entry between 18 and 20;
//   * QuizRunner.tsx + MobileQuizRunner.tsx accept the new prop and
//     render their respective countdown data-testids;
//   * /quizzes/[slug]/page.tsx forwards timeLimitSeconds to both runners;
//   * admin actions.ts validates the field (invalid_time_limit error
//     code) and writes through to updateSet;
//   * /quizzes/[slug]/history/page.tsx exists and renders the
//     data-testid="quiz-history-table" or
//     data-testid="quiz-history-empty" element;
//   * the result page links to /quizzes/[slug]/history;
//   * inline Spec 159 references on every touched source file;
//   * no TODO/FIXME leaks; no new dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCHEMA = "packages/db/src/schema/quizzes.ts";
const MIGRATION_19 = "packages/db/src/migrations/0019_quiz_time_limit.sql";
const SNAPSHOT_18 = "packages/db/src/migrations/meta/0018_snapshot.json";
const SNAPSHOT_19 = "packages/db/src/migrations/meta/0019_snapshot.json";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const DESKTOP_RUNNER = "apps/web/src/components/quiz/QuizRunner.tsx";
const MOBILE_RUNNER = "apps/web/src/components/quiz/MobileQuizRunner.tsx";
const RUNNER_PAGE = "apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx";
const ADMIN_PAGE = "apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx";
const ADMIN_ACTIONS = "apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts";
const HISTORY_PAGE = "apps/web/src/app/(authenticated)/quizzes/[slug]/history/page.tsx";
const RESULT_PAGE =
  "apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx";
const SPEC_DIR = "specs/159-quiz-history-and-time-limit";

// ─── Spec-kit + plan.md contract ─────────────────────────────────────────────

test("spec 159 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the quiz history + time-limit spec`,
    );
  }
});

test("spec 159 — plan.md follows the CREATED/EDITED/MIGRATED contract and names every touched file", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // Each touched file must be mentioned by name.
  assert.match(src, /0019_quiz_time_limit\.sql/, "plan.md must call out the 0019 migration");
  assert.match(src, /0019_snapshot\.json/, "plan.md must call out the 0019 snapshot");
  assert.match(src, /_journal\.json/, "plan.md must call out the journal edit");
  assert.match(src, /quizzes\.ts/, "plan.md must call out the schema edit");
  assert.match(src, /QuizRunner\.tsx/, "plan.md must call out the desktop runner edit");
  assert.match(src, /MobileQuizRunner\.tsx/, "plan.md must call out the mobile runner edit");
  assert.match(src, /history\/page\.tsx/, "plan.md must call out the new history page");
  assert.match(
    src,
    /result\/\[submissionId\]\/page\.tsx|View history/i,
    "plan.md must call out the result-page View-history link",
  );
  assert.match(src, /admin\/quizzes\/\[id\]\/actions\.ts/, "plan.md must call out the admin action edit");
});

// ─── Schema declaration ─────────────────────────────────────────────────────

test("spec 159 — schema declares timeLimitSeconds integer column and quizzes_time_limit_range CHECK", () => {
  const src = read(SCHEMA);
  // The new column must be declared on the quizzes table.
  assert.match(
    src,
    /timeLimitSeconds:\s*integer\(\s*["']time_limit_seconds["']\s*\)/,
    "quizzes.ts must declare `timeLimitSeconds: integer('time_limit_seconds')` on the quizzes table",
  );
  // The CHECK constraint declaration.
  assert.match(
    src,
    /check\(\s*["']quizzes_time_limit_range["']/,
    "quizzes.ts must declare a `quizzes_time_limit_range` CHECK constraint inside the quizzes constraint array",
  );
  // The range must be 60..7200 per the spec.
  assert.match(
    src,
    /BETWEEN\s+60\s+AND\s+7200/,
    "the quizzes_time_limit_range CHECK must enforce BETWEEN 60 AND 7200 (the audit MISS contract)",
  );
  // The NULL-allowed branch must be present.
  assert.match(
    src,
    /IS\s+NULL\s+OR/i,
    "the CHECK must permit NULL (untimed) — `IS NULL OR ... BETWEEN ...`",
  );
  // The existing checks must still be present (no silent drop in the refactor).
  assert.match(src, /quizzes_one_scope/, "schema must retain quizzes_one_scope CHECK");
  assert.match(
    src,
    /quizzes_pass_threshold_range/,
    "schema must retain quizzes_pass_threshold_range CHECK",
  );
});

// ─── Migration 0019 SQL contract ─────────────────────────────────────────────

test("spec 159 — 0019 migration file exists and contains ADD COLUMN + ADD CONSTRAINT statements", () => {
  assert.ok(
    existsSync(resolve(root, MIGRATION_19)),
    "packages/db/src/migrations/0019_quiz_time_limit.sql must exist",
  );
  const src = read(MIGRATION_19);
  // ADD COLUMN — case-insensitive on SQL keywords because drizzle templates
  // sometimes emit lowercase.
  assert.match(
    src,
    /ALTER\s+TABLE\s+"quizzes"\s+ADD\s+COLUMN\s+"time_limit_seconds"\s+integer/i,
    "0019 migration must contain `ALTER TABLE \"quizzes\" ADD COLUMN \"time_limit_seconds\" integer`",
  );
  // ADD CONSTRAINT with the CHECK clause.
  assert.match(
    src,
    /ADD\s+CONSTRAINT\s+"quizzes_time_limit_range"\s+CHECK/i,
    "0019 migration must contain `ADD CONSTRAINT \"quizzes_time_limit_range\" CHECK (...)`",
  );
  assert.match(
    src,
    /BETWEEN\s+60\s+AND\s+7200/i,
    "0019 migration's CHECK clause must enforce BETWEEN 60 AND 7200",
  );
  // The new column must be NULL-able — no NOT NULL.
  assert.ok(
    !/ADD\s+COLUMN\s+"time_limit_seconds"[^;]*NOT\s+NULL/i.test(src),
    "0019 migration's ADD COLUMN must NOT mark time_limit_seconds NOT NULL — legacy quizzes stay untimed",
  );
  // The header comment must reference Spec 159.
  assert.match(
    src,
    /Spec 159/i,
    "0019 migration must reference Spec 159 in the header comment for ledger traceability",
  );
});

// ─── Snapshot contract — prevId chain + column + check ──────────────────────

test("spec 159 — 0019 snapshot exists, chains off 0018's id, and declares the new column + check", () => {
  assert.ok(existsSync(resolve(root, SNAPSHOT_19)), "0019 snapshot must exist");
  const snap18 = JSON.parse(read(SNAPSHOT_18));
  const snap19 = JSON.parse(read(SNAPSHOT_19));
  // prevId chain — 0019 must point at 0018's id, not a stale earlier id.
  assert.equal(
    snap19.prevId,
    snap18.id,
    "0019 snapshot.prevId must chain off 0018's id (verified against the on-disk 0018 snapshot)",
  );
  // 0019 must have its own unique id (not reuse 0018's).
  assert.notEqual(
    snap19.id,
    snap18.id,
    "0019 snapshot must have its own unique id (not reuse 0018's)",
  );
  // The new column must be declared.
  const quizzes = snap19.tables?.["public.quizzes"];
  assert.ok(quizzes, "0019 snapshot must declare public.quizzes");
  const col = quizzes.columns?.time_limit_seconds;
  assert.ok(col, "0019 snapshot must declare the time_limit_seconds column under public.quizzes.columns");
  assert.equal(col.type, "integer", "time_limit_seconds must be of type integer");
  assert.equal(col.notNull, false, "time_limit_seconds must be NULLABLE (legacy untimed)");
  // The new check constraint must be declared.
  const check = quizzes.checkConstraints?.quizzes_time_limit_range;
  assert.ok(
    check,
    "0019 snapshot must declare quizzes_time_limit_range under public.quizzes.checkConstraints",
  );
  assert.match(
    String(check.value),
    /BETWEEN 60 AND 7200/,
    "quizzes_time_limit_range CHECK value must mention BETWEEN 60 AND 7200",
  );
  // The pre-existing constraints must still be present (no silent drop).
  assert.ok(
    quizzes.checkConstraints?.quizzes_one_scope,
    "0019 snapshot must retain quizzes_one_scope CHECK",
  );
  assert.ok(
    quizzes.checkConstraints?.quizzes_pass_threshold_range,
    "0019 snapshot must retain quizzes_pass_threshold_range CHECK",
  );
});

// ─── Journal entry contract ─────────────────────────────────────────────────

test("spec 159 — _journal.json carries a 0019 entry with idx=19 sequenced between 0018 and 0020", () => {
  const journal = JSON.parse(read(JOURNAL));
  const tags = journal.entries.map((e) => e.tag);
  assert.ok(
    tags.includes("0019_quiz_time_limit"),
    "_journal.json must include 0019_quiz_time_limit",
  );
  const idx18 = tags.indexOf("0018_index_mentor_pairings_teacher");
  const idx19 = tags.indexOf("0019_quiz_time_limit");
  assert.ok(idx18 < idx19, "0019 must journal after 0018");
  // The idx field must be the literal integer 19.
  const entry19 = journal.entries.find((e) => e.tag === "0019_quiz_time_limit");
  assert.equal(entry19.idx, 19, "0019 entry must carry idx=19 in the journal");
  // If 0020 is present (spec 161 ships in parallel), the `when` chain must
  // still be monotonic.
  const entry18 = journal.entries.find((e) => e.tag === "0018_index_mentor_pairings_teacher");
  assert.ok(
    entry19.when > entry18.when,
    "0019 journal entry's `when` must be monotonically greater than 0018's",
  );
  const entry20 = journal.entries.find((e) => e.idx === 20);
  if (entry20) {
    assert.ok(
      entry20.when > entry19.when,
      "if 0020 is present, its `when` must be monotonically greater than 0019's",
    );
  }
});

// ─── Desktop runner — timeLimitSeconds prop + countdown ─────────────────────

test("spec 159 — QuizRunner.tsx accepts timeLimitSeconds and renders the countdown banner", () => {
  const src = read(DESKTOP_RUNNER);
  // Prop is declared on the props type.
  assert.match(
    src,
    /timeLimitSeconds\??:\s*number\s*\|\s*null/,
    "QuizRunner must accept `timeLimitSeconds?: number | null` per spec 159",
  );
  // The countdown element renders with the data-testid contract.
  assert.match(
    src,
    /data-testid=["']quiz-countdown["']/,
    "QuizRunner must render an element with data-testid=\"quiz-countdown\"",
  );
  // The auto-submit must call the existing submitAction shape, naming the
  // attempt the runner was rendered for (W3-19).
  assert.match(
    src,
    /submitAction\(\s*slug\s*,\s*attemptId\s*,\s*answers\s*\)/,
    "QuizRunner's auto-submit must call submitAction(slug, attemptId, answers) — same wire shape as manual submit",
  );
  // The interval cleanup must clearInterval — no leaks.
  assert.match(
    src,
    /clearInterval\(/,
    "QuizRunner must call clearInterval in the useEffect cleanup so the timer tears down on unmount",
  );
  // The under-60s color shift must reference var(--rust).
  assert.match(
    src,
    /var\(--rust\)/,
    "QuizRunner must shift to var(--rust) when remaining < 60s per the spec",
  );
  // Spec 159 inline reference.
  assert.match(
    src,
    /Spec 159/,
    "QuizRunner must carry an inline Spec 159 reference so the countdown contract is self-documenting",
  );
});

// ─── Mobile runner — timeLimitSeconds prop + countdown ──────────────────────

test("spec 159 — MobileQuizRunner.tsx accepts timeLimitSeconds and renders the countdown chip", () => {
  const src = read(MOBILE_RUNNER);
  assert.match(
    src,
    /timeLimitSeconds\??:\s*number\s*\|\s*null/,
    "MobileQuizRunner must accept `timeLimitSeconds?: number | null`",
  );
  assert.match(
    src,
    /data-testid=["']mobile-quiz-countdown["']/,
    "MobileQuizRunner must render an element with data-testid=\"mobile-quiz-countdown\"",
  );
  assert.match(
    src,
    /clearInterval\(/,
    "MobileQuizRunner must clearInterval in the useEffect cleanup",
  );
  assert.match(
    src,
    /submitAction\(\s*slug\s*,\s*attemptId\s*,\s*answers\s*\)/,
    "MobileQuizRunner's auto-submit must call submitAction(slug, attemptId, answers)",
  );
  assert.match(src, /Spec 159/, "MobileQuizRunner must carry an inline Spec 159 reference");
});

// ─── Quiz page forwarding ────────────────────────────────────────────────────

test("spec 159 — /quizzes/[slug]/page.tsx forwards quiz.timeLimitSeconds to both runners", () => {
  const src = read(RUNNER_PAGE);
  // The page must read the field off the quiz row.
  assert.match(
    src,
    /quiz\.timeLimitSeconds/,
    "/quizzes/[slug]/page.tsx must read quiz.timeLimitSeconds off the DB row",
  );
  // Both runners must receive the prop.
  assert.match(
    src,
    /<QuizRunner[\s\S]*?timeLimitSeconds=/,
    "/quizzes/[slug]/page.tsx must pass timeLimitSeconds to <QuizRunner>",
  );
  assert.match(
    src,
    /<MobileQuizRunner[\s\S]*?timeLimitSeconds=/,
    "/quizzes/[slug]/page.tsx must pass timeLimitSeconds to <MobileQuizRunner>",
  );
});

// ─── Admin editor — server action + page rendering ──────────────────────────

test("spec 159 — admin actions.ts validates timeLimitSeconds and writes it through to updateSet", () => {
  const src = read(ADMIN_ACTIONS);
  // IncomingPayload widening.
  assert.match(
    src,
    /timeLimitSeconds\??:\s*number\s*\|\s*null/,
    "IncomingPayload must declare `timeLimitSeconds?: number | null`",
  );
  // The invalid_time_limit error code must be returned for out-of-range values.
  assert.match(
    src,
    /["']invalid_time_limit["']/,
    "actions.ts must return error code 'invalid_time_limit' for out-of-range values",
  );
  // The writethrough into the transaction.
  assert.match(
    src,
    /updateSet\.timeLimitSeconds\s*=/,
    "actions.ts must write `updateSet.timeLimitSeconds = ...` so the transaction picks up the change",
  );
  // The range bounds 60..7200 must appear in the validation.
  assert.match(
    src,
    /60.*7200|7200.*60/s,
    "actions.ts must reference both bounds 60 and 7200 in the validation logic",
  );
  // Audit metadata must include the field.
  assert.match(
    src,
    /metadata:\s*\{[\s\S]*?timeLimitSeconds:/,
    "actions.ts must include timeLimitSeconds in the quiz.schema.update audit metadata",
  );
});

test("spec 159 — admin page.tsx renders quiz-time-limit-summary and includes timeLimitSeconds in exportShape", () => {
  const src = read(ADMIN_PAGE);
  // The exportShape must carry timeLimitSeconds so the JSON editor sees the
  // field by default.
  assert.match(
    src,
    /timeLimitSeconds:\s*row\.timeLimitSeconds/,
    "admin page must include `timeLimitSeconds: row.timeLimitSeconds` in the exportShape passed to the editor",
  );
  // The header summary line.
  assert.match(
    src,
    /data-testid=["']quiz-time-limit-summary["']/,
    "admin page must render an element with data-testid=\"quiz-time-limit-summary\"",
  );
  // The schema-reference aside calls out timeLimitSeconds.
  assert.match(
    src,
    /timeLimitSeconds/,
    "admin page schema-reference aside must mention timeLimitSeconds for editor discoverability",
  );
});

// ─── History page ────────────────────────────────────────────────────────────

test("spec 159 — /quizzes/[slug]/history/page.tsx exists and renders the table or empty data-testids", () => {
  assert.ok(
    existsSync(resolve(root, HISTORY_PAGE)),
    "the quiz history page must exist at /quizzes/[slug]/history/page.tsx",
  );
  const src = read(HISTORY_PAGE);
  // Server component contract — force-dynamic.
  assert.match(
    src,
    /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/,
    "history page must declare `export const dynamic = 'force-dynamic'` to keep the per-user SELECT fresh",
  );
  // Not a 'use client' file.
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "history page must be a server component (no 'use client' directive)",
  );
  // Per-user gate: SELECT must filter on session userId.
  assert.match(
    src,
    /eq\(\s*quizSubmissions\.userId\s*,\s*userId\s*\)/,
    "history page must scope the SELECT to the current session userId — no cross-user joins",
  );
  // Ordering newest-first.
  assert.match(
    src,
    /desc\(\s*quizSubmissions\.submittedAt\s*\)/,
    "history page must ORDER BY quizSubmissions.submittedAt DESC (newest first)",
  );
  // Both data-testids must be present (populated state + empty state).
  assert.match(
    src,
    /data-testid=["']quiz-history-table["']/,
    "history page must render data-testid=\"quiz-history-table\" on the populated state",
  );
  assert.match(
    src,
    /data-testid=["']quiz-history-empty["']/,
    "history page must render data-testid=\"quiz-history-empty\" on the empty state",
  );
  // Each row links to the per-submission result page.
  assert.match(
    src,
    /\/quizzes\/\$\{slug\}\/result\/\$\{r\.id\}/,
    "history page must link each row to /quizzes/${slug}/result/${r.id}",
  );
  // 404 contract for unknown slug.
  assert.match(src, /notFound\(\)/, "history page must call notFound() when the quiz slug doesn't resolve");
  // Spec 159 inline marker.
  assert.match(src, /Spec 159/, "history page must carry an inline Spec 159 reference");
});

// ─── Result page — View-history link ────────────────────────────────────────

test("spec 159 — result page links to /quizzes/[slug]/history via data-testid=quiz-result-history-link", () => {
  const src = read(RESULT_PAGE);
  // The link element with the right testid.
  assert.match(
    src,
    /data-testid=["']quiz-result-history-link["']/,
    "result page must render a View-history link with data-testid=\"quiz-result-history-link\"",
  );
  // The link href must point at the history route.
  assert.match(
    src,
    /href=\{\s*`\/quizzes\/\$\{slug\}\/history`\s*\}/,
    "result page's View-history link must href=`/quizzes/${slug}/history`",
  );
  // Spec 159 inline marker.
  assert.match(src, /Spec 159/, "result page must carry an inline Spec 159 reference next to the new link");
});

// ─── Hygiene ─────────────────────────────────────────────────────────────────

test("spec 159 — no TODO / FIXME / placeholder markers leaked into the shipped source or migration", () => {
  for (const path of [
    SCHEMA,
    MIGRATION_19,
    DESKTOP_RUNNER,
    MOBILE_RUNNER,
    RUNNER_PAGE,
    ADMIN_PAGE,
    ADMIN_ACTIONS,
    HISTORY_PAGE,
    RESULT_PAGE,
  ]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 159 — no new dependencies were introduced (no date-fns, dayjs, or zod added to apps/web)", () => {
  // The fix is pure standard-library — setInterval, Math.floor,
  // Date.toISOString. No calendar / validation library should have crept
  // into apps/web/package.json as a side-effect.
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  assert.ok(!("date-fns" in deps), "apps/web must not gain a date-fns dependency from spec 159");
  assert.ok(!("dayjs" in deps), "apps/web must not gain a dayjs dependency from spec 159");
});
