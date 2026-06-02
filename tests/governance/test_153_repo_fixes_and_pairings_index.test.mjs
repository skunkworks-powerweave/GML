// Governance test for spec 153 — Repo detail fixes + mentor_pairings.teacher_id
// index (Workflow Run 14 audit-closure MEDIUM).
//
// Three findings consolidated into one spec:
//
//   1. apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx (EDITED)
//      — the mentor SELECT now filters `and(eq(mentors.id, id),
//        eq(mentors.active, true))` so a soft-retired mentor 404s
//        consistently with the index page (which already filters on
//        active=true). The mentors schema uses `active boolean`, not
//        `deletedAt`; the schema confirmation is encoded in the
//        WHERE-clause shape we assert below.
//
//   2. apps/web/src/app/(authenticated)/repo/sessions/page.tsx (EDITED)
//      — the from / to date filter validators layer a Date-parse +
//        ISO round-trip equality check on top of the ISO_DATE_RE
//        regex so malformed calendar values (2026-13-45, 2026-02-30)
//        silently drop the filter instead of throwing a Postgres
//        date-cast error.
//
//   3. packages/db/src/schema/mentorship.ts (EDITED) +
//      packages/db/src/migrations/0018_index_mentor_pairings_teacher.sql
//      (CREATED) + meta/0018_snapshot.json (CREATED) +
//      meta/_journal.json (EDITED) — add a btree index on
//      mentor_pairings.teacher_id so "all pairings for teacher X"
//      lookups are an index seek, not a seqscan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MENTOR_DETAIL = "apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx";
const SESSIONS_INDEX = "apps/web/src/app/(authenticated)/repo/sessions/page.tsx";
const MENTORSHIP_SCHEMA = "packages/db/src/schema/mentorship.ts";
const MIGRATION_18 = "packages/db/src/migrations/0018_index_mentor_pairings_teacher.sql";
const SNAPSHOT_17 = "packages/db/src/migrations/meta/0017_snapshot.json";
const SNAPSHOT_18 = "packages/db/src/migrations/meta/0018_snapshot.json";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const SPEC_DIR = "specs/153-repo-fixes-and-pairings-index";

// ── Spec-kit + plan.md contract ────────────────────────────────────────────────

test("spec 153 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the repo-fixes-and-pairings-index spec`,
    );
  }
});

test("spec 153 — plan.md follows the CREATED/EDITED/MIGRATED contract and names all touched files", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // Call-out checks: each touched file must be mentioned by name in the plan.
  assert.match(src, /0018_index_mentor_pairings_teacher\.sql/, "plan.md must call out the 0018 migration");
  assert.match(src, /mentor\/\[id\]\/page\.tsx/, "plan.md must call out the mentor detail edit");
  assert.match(src, /sessions\/page\.tsx/, "plan.md must call out the sessions page edit");
  assert.match(src, /mentorship\.ts/, "plan.md must call out the mentorship schema edit");
  assert.match(src, /_journal\.json/, "plan.md must call out the journal edit");
});

// ── Mentor detail — active filter ──────────────────────────────────────────────

test("spec 153 — mentor detail page imports `and` from drizzle-orm", () => {
  const src = read(MENTOR_DETAIL);
  // Both `and` and `eq` must be imported — without `and` the compound
  // WHERE clause below can't compile.
  assert.match(
    src,
    /import\s*\{[^}]*\band\b[^}]*\}\s*from\s*["']drizzle-orm["']/,
    "mentor detail page must import `and` from drizzle-orm to compose the active-filter clause",
  );
  assert.match(
    src,
    /import\s*\{[^}]*\beq\b[^}]*\}\s*from\s*["']drizzle-orm["']/,
    "mentor detail page must continue to import `eq` from drizzle-orm",
  );
});

test("spec 153 — mentor detail SELECT filters on both id AND active=true", () => {
  const src = read(MENTOR_DETAIL);
  // The WHERE clause must compose `eq(mentors.id, id)` AND `eq(mentors.active, true)`
  // via `and(...)`. The whitespace between the two predicates is tolerated;
  // the contract is just that both predicates are present inside an `and(...)`
  // wrapper passed to `.where(...)`.
  assert.match(
    src,
    /\.where\(\s*and\(\s*eq\(\s*mentors\.id\s*,\s*id\s*\)\s*,\s*eq\(\s*mentors\.active\s*,\s*true\s*\)\s*\)\s*\)/,
    "mentor detail SELECT must use `.where(and(eq(mentors.id, id), eq(mentors.active, true)))` so a soft-retired mentor 404s consistently with the index page",
  );
  // The pre-fix shape (.where(eq(mentors.id, id)) with no `and` wrapper)
  // must be gone. We strip comments before checking so a comment can't
  // satisfy the assertion either way.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    codeOnly,
    /\.where\(\s*eq\(\s*mentors\.id\s*,\s*id\s*\)\s*\)\s*\.limit/,
    "the pre-fix `.where(eq(mentors.id, id))` shape (no active filter) must be removed",
  );
});

// ── Sessions index — date filter calendar validation ──────────────────────────

test("spec 153 — sessions page declares a parseIsoDateFilter helper", () => {
  const src = read(SESSIONS_INDEX);
  // The helper must be declared at module scope. The function signature
  // accepts `string | undefined` and returns `string | undefined` so a
  // caller can plug it in without a null-check.
  assert.match(
    src,
    /function\s+parseIsoDateFilter\s*\(\s*value\s*:\s*string\s*\|\s*undefined\s*\)\s*:\s*string\s*\|\s*undefined/,
    "sessions page must declare `function parseIsoDateFilter(value: string | undefined): string | undefined` at module scope",
  );
});

test("spec 153 — parseIsoDateFilter layers regex + Date parse + ISO round-trip equality", () => {
  const src = read(SESSIONS_INDEX);
  // Layer 1: the regex test must still run. ISO_DATE_RE is the existing
  // module-level constant; we pin its name to ensure the helper composes
  // with it rather than inlining a parallel regex.
  assert.match(
    src,
    /ISO_DATE_RE\.test\(\s*value\s*\)/,
    "parseIsoDateFilter must call ISO_DATE_RE.test(value) as its first calendar-shape guard",
  );
  // Layer 2: the Date parse. We accept either `new Date(value)` or
  // `new Date(value + "T00:00:00Z")` — the helper in our implementation
  // uses the UTC-anchored form to avoid timezone-shift edge cases at the
  // day boundary.
  assert.match(
    src,
    /new\s+Date\(\s*value\s*\+\s*["']T00:00:00Z["']\s*\)/,
    "parseIsoDateFilter must construct `new Date(value + 'T00:00:00Z')` so the parse is timezone-anchored",
  );
  // Layer 3: the isNaN check.
  assert.match(
    src,
    /isNaN\(\s*[^)]+\.getTime\(\)\s*\)/,
    "parseIsoDateFilter must guard on isNaN(parsed.getTime()) so unparseable strings drop the filter",
  );
  // Layer 4: the round-trip equality. We slice `.toISOString().slice(0, 10)`
  // and compare to the input. This is what catches "2026-13-45"
  // (which Date silently normalises to "2027-02-14") and "2026-02-30"
  // (normalises to "2026-03-02").
  assert.match(
    src,
    /\.toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/,
    "parseIsoDateFilter must compute `parsed.toISOString().slice(0, 10)` for the round-trip equality check",
  );
});

test("spec 153 — sessions page derives fromFilter and toFilter via the helper", () => {
  const src = read(SESSIONS_INDEX);
  // Both filters must be derived from the helper — without this the validation
  // refinement only protects half the WHERE clause.
  assert.match(
    src,
    /const\s+fromFilter\s*=\s*parseIsoDateFilter\(\s*sp\.from\s*\)/,
    "fromFilter must be derived via parseIsoDateFilter(sp.from)",
  );
  assert.match(
    src,
    /const\s+toFilter\s*=\s*parseIsoDateFilter\(\s*sp\.to\s*\)/,
    "toFilter must be derived via parseIsoDateFilter(sp.to)",
  );
  // The pre-fix shape (`sp.from && ISO_DATE_RE.test(sp.from) ? sp.from : undefined`)
  // for either filter must be gone from the live derivation. We allow it in
  // comments (documentation references to the pre-fix shape).
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    codeOnly,
    /const\s+fromFilter\s*=\s*sp\.from\s*&&\s*ISO_DATE_RE/,
    "the pre-fix `fromFilter = sp.from && ISO_DATE_RE.test(sp.from)` shape must be replaced by the helper call",
  );
});

// ── Schema declaration ─────────────────────────────────────────────────────────

test("spec 153 — mentorship schema declares mentor_pairings_teacher_idx on teacherId", () => {
  const src = read(MENTORSHIP_SCHEMA);
  // The new index declaration must be present in the mentorPairings constraint
  // array. Whitespace + linebreaks between `index(...)` and `.on(...)` are
  // tolerated.
  assert.match(
    src,
    /index\(\s*["']mentor_pairings_teacher_idx["']\s*\)\.on\(\s*t\.teacherId\s*\)/,
    "mentorship.ts must declare `index('mentor_pairings_teacher_idx').on(t.teacherId)` inside the mentorPairings constraint array",
  );
  // The pre-existing indexes must still be declared (we don't want a refactor
  // to silently drop them while moving the new one in).
  assert.match(
    src,
    /uniqueIndex\(\s*["']mentor_pairings_mentor_teacher_started_uq["']\s*\)/,
    "mentorship.ts must retain the existing compound unique mentor_pairings_mentor_teacher_started_uq",
  );
  assert.match(
    src,
    /index\(\s*["']mentor_pairings_status_idx["']\s*\)/,
    "mentorship.ts must retain the existing mentor_pairings_status_idx",
  );
});

// ── Migration 0018 SQL contract ────────────────────────────────────────────────

test("spec 153 — 0018 migration file exists and contains the CREATE INDEX statement", () => {
  assert.ok(
    existsSync(resolve(root, MIGRATION_18)),
    "packages/db/src/migrations/0018_index_mentor_pairings_teacher.sql must exist",
  );
  const src = read(MIGRATION_18);
  // The CREATE INDEX statement — case-insensitive on the SQL keywords because
  // some drizzle templates emit `create index` in lowercase.
  assert.match(
    src,
    /CREATE\s+INDEX\s+"mentor_pairings_teacher_idx"\s+ON\s+"mentor_pairings"\s+USING\s+btree\s*\(\s*"teacher_id"\s*\)/i,
    "0018 migration must contain the literal CREATE INDEX statement on mentor_pairings(teacher_id)",
  );
  // CONCURRENTLY must NOT be used — drizzle-kit wraps migrations in
  // transactions and CONCURRENTLY is incompatible with transactional DDL.
  // The rationale IS documented in the SQL header comment, so we strip
  // SQL comments (`-- ...` line comments) before asserting absence.
  const sqlOnly = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(
    sqlOnly,
    /CREATE\s+INDEX\s+CONCURRENTLY/i,
    "0018 migration must NOT use CREATE INDEX CONCURRENTLY as a live statement — drizzle-kit wraps in a transaction and CONCURRENTLY is incompatible",
  );
  // The header comment must carry a spec 153 reference for ledger traceability.
  assert.match(
    src,
    /Spec 153/i,
    "0018 migration must reference Spec 153 in its header comment for ledger traceability",
  );
});

// ── Snapshot contract — prevId chain + index declaration ───────────────────────

test("spec 153 — 0018 snapshot exists, chains off 0017's id, and declares the new index", () => {
  assert.ok(existsSync(resolve(root, SNAPSHOT_18)), "0018 snapshot must exist");
  const snap17 = JSON.parse(read(SNAPSHOT_17));
  const snap18 = JSON.parse(read(SNAPSHOT_18));
  // prevId chain — 0018 must point at 0017's id, not a stale earlier id.
  assert.equal(
    snap18.prevId,
    snap17.id,
    "0018 snapshot prevId must chain off 0017's id (verified against the on-disk 0017 snapshot)",
  );
  // 0018 must have its own unique id (not reuse 0017's).
  assert.notEqual(
    snap18.id,
    snap17.id,
    "0018 snapshot must have its own unique id (not reuse 0017's)",
  );
  // The new index must be declared under mentor_pairings.indexes.
  const mp = snap18.tables?.["public.mentor_pairings"];
  assert.ok(mp, "0018 snapshot must declare public.mentor_pairings");
  assert.ok(
    mp.indexes?.mentor_pairings_teacher_idx,
    "0018 snapshot's mentor_pairings.indexes must declare mentor_pairings_teacher_idx",
  );
  // The index must be on teacher_id, btree, not unique.
  const idx = mp.indexes.mentor_pairings_teacher_idx;
  assert.equal(idx.isUnique, false, "mentor_pairings_teacher_idx must NOT be unique");
  assert.equal(idx.method, "btree", "mentor_pairings_teacher_idx must use btree");
  assert.ok(
    Array.isArray(idx.columns) && idx.columns.length === 1 && idx.columns[0].expression === "teacher_id",
    "mentor_pairings_teacher_idx must be a single-column index on teacher_id",
  );
  // The pre-existing indexes must still be present in the snapshot — we
  // don't want the snapshot to silently drop them.
  assert.ok(
    mp.indexes?.mentor_pairings_mentor_teacher_started_uq,
    "0018 snapshot must retain the existing mentor_pairings_mentor_teacher_started_uq index",
  );
  assert.ok(
    mp.indexes?.mentor_pairings_status_idx,
    "0018 snapshot must retain the existing mentor_pairings_status_idx index",
  );
});

// ── Journal entry contract ─────────────────────────────────────────────────────

test("spec 153 — _journal.json carries a 0018 entry with idx=18 sequenced after 0017", () => {
  const journal = JSON.parse(read(JOURNAL));
  const tags = journal.entries.map((e) => e.tag);
  assert.ok(
    tags.includes("0018_index_mentor_pairings_teacher"),
    "_journal.json must include 0018_index_mentor_pairings_teacher",
  );
  // Sequence check — 18 must sit after 17.
  const idx17 = tags.indexOf("0017_whatsapp_dedup");
  const idx18 = tags.indexOf("0018_index_mentor_pairings_teacher");
  assert.ok(idx17 < idx18, "0018 must journal after 0017");
  // The idx field must be the literal integer 18.
  const entry18 = journal.entries.find((e) => e.tag === "0018_index_mentor_pairings_teacher");
  assert.equal(entry18.idx, 18, "0018 entry must carry idx=18 in the journal");
  // The `when` timestamp must be greater than 0017's (monotonic chain).
  const entry17 = journal.entries.find((e) => e.tag === "0017_whatsapp_dedup");
  assert.ok(
    entry18.when > entry17.when,
    "0018 journal entry's `when` must be monotonically greater than 0017's",
  );
});

// ── Inline spec-153 reference markers ──────────────────────────────────────────

test("spec 153 — inline source comments reference Spec 153 so the fix is self-documenting", () => {
  // Each touched source file should carry a "Spec 153" marker in a comment
  // so a future contributor reading the file knows to consult this spec
  // before refactoring the predicate / helper / index. Same pattern as
  // spec 148's transaction wrap and spec 149's mountedRef.
  const mentorSrc = read(MENTOR_DETAIL);
  assert.match(
    mentorSrc,
    /Spec 153/,
    "mentor detail page must carry an inline `Spec 153` reference so the active-filter fix is self-documenting",
  );
  const sessionsSrc = read(SESSIONS_INDEX);
  assert.match(
    sessionsSrc,
    /Spec 153/,
    "sessions page must carry an inline `Spec 153` reference so the date-filter fix is self-documenting",
  );
  const schemaSrc = read(MENTORSHIP_SCHEMA);
  assert.match(
    schemaSrc,
    /Spec 153/,
    "mentorship schema must carry an inline `Spec 153` reference next to the new index declaration",
  );
});

// ── No-regression / hygiene ────────────────────────────────────────────────────

test("spec 153 — no TODO / FIXME / placeholder markers leaked into the shipped source or migration", () => {
  for (const path of [MENTOR_DETAIL, SESSIONS_INDEX, MENTORSHIP_SCHEMA, MIGRATION_18]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 153 — no new dependencies were introduced (no zod / date-fns / dayjs)", () => {
  // The fix is pure standard-library — regex + Date + JSON snapshot edits.
  // No validation library, no calendar library should have crept into
  // apps/web/package.json as a side-effect.
  const pkg = read("apps/web/package.json");
  // We test against full-name imports, since `zod` is sometimes already
  // present in other workspaces; the contract here is that THIS spec
  // didn't introduce a new top-level dep.
  // (If zod is already a transitive dep elsewhere, that's fine — the
  // spec didn't add it.)
  const pkgJson = JSON.parse(pkg);
  const deps = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.devDependencies ?? {}) };
  assert.ok(!("date-fns" in deps), "apps/web must not gain a date-fns dependency from spec 153");
  assert.ok(!("dayjs" in deps), "apps/web must not gain a dayjs dependency from spec 153");
});
