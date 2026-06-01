import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCHEMA_FILE = "packages/db/src/schema/quizzes.ts";
const SCHEMA_BARREL = "packages/db/src/schema/index.ts";
const MIGRATION_SQL = "packages/db/src/migrations/0014_quizzes_schema.sql";
const MIGRATION_JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const MIGRATION_SNAPSHOT = "packages/db/src/migrations/meta/0014_snapshot.json";

const RUNNER_PAGE = "apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx";
const RUNNER_COMPONENT = "apps/web/src/components/quiz/QuizRunner.tsx";
const RESULT_PAGE =
  "apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx";
const ADMIN_INDEX = "apps/web/src/app/(authenticated)/admin/quizzes/page.tsx";
const ADMIN_DETAIL = "apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx";
const ADMIN_PARTS = "apps/web/src/app/(authenticated)/admin/quizzes/[id]/parts.tsx";
const ADMIN_ACTIONS = "apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts";

test("spec 120 — all target files exist", () => {
  const targets = [
    SCHEMA_FILE,
    SCHEMA_BARREL,
    MIGRATION_SQL,
    MIGRATION_JOURNAL,
    MIGRATION_SNAPSHOT,
    RUNNER_PAGE,
    RUNNER_COMPONENT,
    RESULT_PAGE,
    ADMIN_INDEX,
    ADMIN_DETAIL,
    ADMIN_PARTS,
    ADMIN_ACTIONS,
  ];
  for (const f of targets) {
    assert.ok(existsSync(resolve(root, f)), `${f} must exist`);
  }
});

test("spec 120 — schema defines three quiz tables with FK + CHECK constraints", () => {
  const src = read(SCHEMA_FILE);
  // The three exported pgTable declarations.
  assert.match(src, /export const quizzes = pgTable\(/);
  assert.match(src, /export const quizQuestions = pgTable\(/);
  assert.match(src, /export const quizSubmissions = pgTable\(/);
  // Foreign keys to subjects + rtt_subjects + users.
  assert.match(src, /\.references\(\(\) => subjects\.id/);
  assert.match(src, /\.references\(\(\) => rttSubjects\.id/);
  assert.match(src, /\.references\(\(\) => users\.id/);
  assert.match(src, /\.references\(\(\) => quizzes\.id/);
  // Exactly-one-of CHECK constraint.
  assert.match(src, /"quizzes_one_scope"/);
  // Pass-threshold range CHECK.
  assert.match(src, /"quizzes_pass_threshold_range"/);
  // Score range CHECK on submissions.
  assert.match(src, /"quiz_submissions_score_range"/);
  // Unique (quizId, sequence) on questions.
  assert.match(src, /quiz_questions_quiz_sequence_uq/);
});

test("spec 120 — barrel re-exports the quizzes schema", () => {
  const src = read(SCHEMA_BARREL);
  assert.match(src, /export \* from "\.\/quizzes"/);
});

test("spec 120 — migration 0014 SQL creates the three tables with all constraints", () => {
  const sql = read(MIGRATION_SQL);
  assert.match(sql, /CREATE TABLE "quizzes"/);
  assert.match(sql, /CREATE TABLE "quiz_questions"/);
  assert.match(sql, /CREATE TABLE "quiz_submissions"/);
  // FK declarations.
  assert.match(sql, /quizzes_subject_id_subjects_id_fk/);
  assert.match(sql, /quizzes_rtt_subject_id_rtt_subjects_id_fk/);
  assert.match(sql, /quiz_questions_quiz_id_quizzes_id_fk/);
  assert.match(sql, /quiz_submissions_quiz_id_quizzes_id_fk/);
  assert.match(sql, /quiz_submissions_user_id_users_id_fk/);
  // Exactly-one-of CHECK.
  assert.match(sql, /"quizzes_one_scope" CHECK/);
  // ON DELETE CASCADE for question/submission rows.
  assert.match(sql, /ON DELETE cascade/i);
  // Unique slug.
  assert.match(sql, /"quizzes_slug_unique" UNIQUE\("slug"\)/);
});

test("spec 120 — journal contains 0014_quizzes_schema entry at idx 14", () => {
  const journal = JSON.parse(read(MIGRATION_JOURNAL));
  const entry = journal.entries.find((e) => e.tag === "0014_quizzes_schema");
  assert.ok(entry, "journal must contain a 0014_quizzes_schema entry");
  assert.equal(entry.idx, 14, "idx must be 14");
  assert.equal(entry.version, "7");
  assert.equal(entry.breakpoints, true);
});

test("spec 120 — 0014 snapshot includes all three new tables", () => {
  const snap = JSON.parse(read(MIGRATION_SNAPSHOT));
  assert.ok(snap.tables["public.quizzes"], "snapshot must include public.quizzes");
  assert.ok(
    snap.tables["public.quiz_questions"],
    "snapshot must include public.quiz_questions",
  );
  assert.ok(
    snap.tables["public.quiz_submissions"],
    "snapshot must include public.quiz_submissions",
  );
  // The check constraint should be present.
  assert.ok(
    snap.tables["public.quizzes"].checkConstraints.quizzes_one_scope,
    "quizzes_one_scope CHECK must be in the snapshot",
  );
});

test("spec 120 — quiz runner page is a server component with submit action", () => {
  const src = read(RUNNER_PAGE);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  // Not a 'use client' file.
  assert.doesNotMatch(src, /^"use client"/m);
  // Server action declared with "use server"
  assert.match(src, /"use server"/);
  assert.match(src, /export async function submitQuizAttempt/);
  // Loads quiz by slug and grades the attempt.
  assert.match(src, /eq\(quizzes\.slug,\s*slug\)/);
  assert.match(src, /quiz_submissions|quizSubmissions/);
  // Audit on submit.
  assert.match(src, /recordAudit\(/);
  assert.match(src, /quiz\.submit/);
  // Redirects to the result page on success.
  assert.match(src, /\/quizzes\/\$\{slug\}\/result\/\$\{submissionId\}/);
});

test("spec 120 — QuizRunner client component renders progress + options + submit", () => {
  const src = read(RUNNER_COMPONENT);
  assert.match(src, /^"use client"/);
  assert.match(src, /export function QuizRunner/);
  // Progress bar + counter from the JSX prototype.
  assert.match(src, /progressPct/);
  // A/B/C/D label generator.
  assert.match(src, /String\.fromCharCode\(65 \+ i\)/);
  // Submit button label matches the spec brief copy.
  assert.match(src, /Submit answers/);
  // Inline tokens (Phase 7/8 styling discipline).
  assert.match(src, /var\(--ink\)/);
  assert.match(src, /var\(--paper\)/);
  // Disabled state prevents submission without a selection.
  assert.match(src, /selection === undefined/);
});

test("spec 120 — result page shows score banner + per-question breakdown + retry CTA", () => {
  const src = read(RESULT_PAGE);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.doesNotMatch(src, /^"use client"/m);
  // Pass/fail banner uses the quiz's passThreshold.
  assert.match(src, /passThreshold/);
  // Per-question breakdown.
  assert.match(src, /correctIndex/);
  assert.match(src, /explanation/);
  // Retake CTA back to the runner.
  assert.match(src, /Retake/);
  assert.match(src, /href=\{`\/quizzes\/\$\{slug\}`\}/);
  // SM-9 light gate: only owner can view their result.
  assert.match(src, /redirect\("\/forbidden"\)/);
});

test("spec 120 — admin index is role-gated and renders the registry table", () => {
  const src = read(ADMIN_INDEX);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /requireRole\(\["programme_admin", "super_admin"\]\)/);
  assert.doesNotMatch(src, /^"use client"/m);
  // The page header copy.
  assert.match(src, /Programme quizzes/);
  // Cross-link back to /admin/forms.
  assert.match(src, /\/admin\/forms/);
  // Each row links to the detail page.
  assert.match(src, /\/admin\/quizzes\/\$\{r\.id\}/);
});

test("spec 120 — admin detail + parts + actions wire role gate, validation, audit", () => {
  const detail = read(ADMIN_DETAIL);
  assert.match(detail, /requireRole\(\["programme_admin", "super_admin"\]\)/);
  assert.match(detail, /notFound\(\)/);
  // Imports the client child.
  assert.match(detail, /QuizSchemaEditor/);

  const parts = read(ADMIN_PARTS);
  assert.match(parts, /^"use client"/);
  assert.match(parts, /export function QuizSchemaEditor/);
  // Server action invocation.
  assert.match(parts, /saveQuizSchema\(quizId, text\)/);
  // Parse-error guard.
  assert.match(parts, /JSON\.parse\(text\)/);

  const actions = read(ADMIN_ACTIONS);
  assert.match(actions, /^"use server"/);
  assert.match(actions, /export async function saveQuizSchema/);
  assert.match(actions, /requireRole\(\["programme_admin", "super_admin"\]\)/);
  // Validation: at least 2 options, correctIndex in bounds.
  assert.match(actions, /at least 2 options/);
  assert.match(actions, /correctIndex/);
  // Replace-all transaction.
  assert.match(actions, /db\.transaction/);
  assert.match(actions, /delete\(quizQuestions\)/);
  // Audit hook on save.
  assert.match(actions, /recordAudit\(/);
  assert.match(actions, /quiz\.schema\.update/);
});

test("spec 120 — inline styles use CSS variable tokens (Phase 7/8 discipline)", () => {
  for (const f of [RUNNER_COMPONENT, RESULT_PAGE, ADMIN_INDEX, ADMIN_DETAIL]) {
    const src = read(f);
    assert.match(src, /var\(--ink\)/, `${f} must use var(--ink)`);
    assert.match(src, /var\(--paper/, `${f} must use var(--paper*)`);
  }
});
