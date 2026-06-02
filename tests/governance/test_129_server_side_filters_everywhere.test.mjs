// Governance test for spec 129 — Server-side filters everywhere.
//
// Workflow Run 11 closure: each affected list page's filter UI must
// reach the Drizzle WHERE clause directly (no client-side
// rows.filter(...) on the visible slice). One assertion per affected
// page checks the WHERE shape + the searchParams contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SPEC_DIR = "specs/129-server-side-filters-everywhere";

const OBSERVATION = "apps/web/src/app/(authenticated)/observation/page.tsx";
const SCHOOLS = "apps/web/src/app/(authenticated)/repo/schools/page.tsx";
const SUBJECTS = "apps/web/src/app/(authenticated)/repo/subjects/page.tsx";
const OUTLINES = "apps/web/src/app/(authenticated)/repo/outlines/page.tsx";
const SESSIONS = "apps/web/src/app/(authenticated)/repo/sessions/page.tsx";
const TEACHERS = "apps/web/src/app/(authenticated)/repo/teachers/page.tsx";
const VIDEOS = "apps/web/src/app/(authenticated)/videos/page.tsx";
const MENTORSHIP = "apps/web/src/app/(authenticated)/mentorship/page.tsx";

const ALL_PAGES = [
  OBSERVATION,
  SCHOOLS,
  SUBJECTS,
  OUTLINES,
  SESSIONS,
  TEACHERS,
  VIDEOS,
  MENTORSHIP,
];

test("spec 129 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the server-side-filters spec`,
    );
  }
});

test("spec 129 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // Each affected page must show up in the EDITED list.
  for (const p of ALL_PAGES) {
    const tail = p.split("/").slice(-2).join("/");
    assert.ok(
      src.includes(tail),
      `plan.md EDITED list must reference ${tail}`,
    );
  }
});

test("spec 129 — every affected page stays a server component (no 'use client')", () => {
  for (const p of ALL_PAGES) {
    const src = read(p);
    assert.ok(
      !/^\s*["']use client["']/m.test(src),
      `${p} must remain a server component — filters use GET <form> or <Link>, not a client handler`,
    );
  }
});

test("spec 129 — /observation accepts status + kind via searchParams and pushes them into the WHERE", () => {
  const src = read(OBSERVATION);
  assert.match(src, /searchParams/, "observation page must accept searchParams");
  // status filter — uses eq(observationCycles.status, …)
  assert.match(
    src,
    /eq\(observationCycles\.status,/,
    "observation page must filter status server-side",
  );
  // kind filter — uses eq(observationCycles.kind, …)
  assert.match(
    src,
    /eq\(observationCycles\.kind,/,
    "observation page must filter kind server-side",
  );
  // searchParams allow-list validation — STATUS_VALUES / KIND_VALUES Sets
  assert.match(
    src,
    /STATUS_VALUES|STATUS_VALUES\.has/,
    "observation page must validate the status searchParam against an allow-list Set",
  );
  assert.match(
    src,
    /KIND_VALUES/,
    "observation page must validate the kind searchParam against an allow-list Set",
  );
});

test("spec 129 — /repo/schools removes the in-memory matchesDistrict filter and uses ilike on districts.code", () => {
  const src = read(SCHOOLS);
  // The old in-memory function must be gone.
  assert.ok(
    !/function matchesDistrict/.test(src),
    "schools page must no longer declare matchesDistrict — the filter moved to SQL",
  );
  assert.ok(
    !/rows\.filter\(matchesDistrict\)/.test(src),
    "schools page must no longer call rows.filter(matchesDistrict) — that ran in JS after the fetch",
  );
  // ilike on districts.code is the new SQL-side filter.
  assert.match(
    src,
    /ilike\(districts\.code/,
    "schools page must use ilike(districts.code, …) to narrow at the SQL layer",
  );
  // Counts come from a GROUP BY round-trip, not rows.filter(...).length.
  assert.match(
    src,
    /\.groupBy\(districts\.code\)/,
    "schools page must roll up district counts via GROUP BY",
  );
});

test("spec 129 — /repo/subjects exposes a grade filter via URL searchParams", () => {
  const src = read(SUBJECTS);
  assert.match(src, /searchParams/, "subjects page must accept searchParams");
  assert.match(src, /name="grade"/, "subjects page must expose a 'grade' GET input");
  // The bound check — only grade 1..12 is accepted as a filter.
  assert.match(
    src,
    />= 1 && gradeParsed <= 12/,
    "subjects page must validate the grade param to the 1..12 range",
  );
  // The WHERE must include the grades_min / grades_max bound predicates.
  assert.match(
    src,
    /lte\(subjects\.gradesMin/,
    "subjects page must use lte(subjects.gradesMin, grade) for the lower bound",
  );
  assert.match(
    src,
    /gte\(subjects\.gradesMax/,
    "subjects page must use gte(subjects.gradesMax, grade) for the upper bound",
  );
});

test("spec 129 — /repo/outlines exposes grade + term + status filters as GET form selects", () => {
  const src = read(OUTLINES);
  assert.match(src, /method="GET"/, "outlines page filter must be a GET form");
  assert.match(src, /name="grade"/, "outlines page must expose a 'grade' select");
  assert.match(src, /name="term"/, "outlines page must expose a 'term' select");
  assert.match(src, /name="status"/, "outlines page must expose a 'status' select");
  // Each filter pushes into the WHERE.
  assert.match(
    src,
    /eq\(courseOutlines\.grade,/,
    "outlines page must filter grade server-side",
  );
  assert.match(
    src,
    /eq\(courseOutlines\.term,/,
    "outlines page must filter term server-side",
  );
  assert.match(
    src,
    /eq\(courseOutlines\.status,/,
    "outlines page must filter status server-side",
  );
});

test("spec 129 — /repo/sessions promotes the rows.filter to a SQL WHERE + adds from/to date range", () => {
  const src = read(SESSIONS);
  // The previous in-memory narrowing must be gone.
  assert.ok(
    !/rows\.filter\(\s*\(s\)\s*=>/.test(src),
    "sessions page must no longer narrow rows in JS — the filter moved to the WHERE",
  );
  // SQL-side status + subject filter.
  assert.match(
    src,
    /eq\(sessions\.status,/,
    "sessions page must filter status server-side",
  );
  assert.match(
    src,
    /eq\(sessions\.subjectId,/,
    "sessions page must filter subjectId server-side",
  );
  // Date range — gte + lte on scheduledDate.
  assert.match(
    src,
    /gte\(sessions\.scheduledDate,/,
    "sessions page must accept a 'from' date filter via gte(scheduledDate, …)",
  );
  assert.match(
    src,
    /lte\(sessions\.scheduledDate,/,
    "sessions page must accept a 'to' date filter via lte(scheduledDate, …)",
  );
  // Form must wire from + to as native HTML date inputs.
  assert.match(src, /name="from"/, "sessions page must expose a 'from' date input");
  assert.match(src, /name="to"/, "sessions page must expose a 'to' date input");
  // The status count aggregate comes from GROUP BY, not from rows.filter(...).length.
  assert.match(
    src,
    /\.groupBy\(sessions\.status\)/,
    "sessions page must roll up per-status counts via GROUP BY",
  );
});

test("spec 129 — /repo/teachers adds school + phase filters via UUID-validated searchParams", () => {
  const src = read(TEACHERS);
  assert.match(src, /searchParams/, "teachers page must accept searchParams");
  assert.match(src, /UUID_RE/, "teachers page must declare a UUID regex to validate id params");
  assert.match(
    src,
    /eq\(teachers\.schoolId,/,
    "teachers page must filter school id server-side",
  );
  assert.match(
    src,
    /eq\(teachers\.currentPhaseId,/,
    "teachers page must filter current phase id server-side",
  );
  assert.match(src, /name="school"/, "teachers page must expose a 'school' select");
  assert.match(src, /name="phase"/, "teachers page must expose a 'phase' select");
});

test("spec 129 — /videos promotes status filter to SQL and adds a source filter", () => {
  const src = read(VIDEOS);
  // The old in-memory narrowing must be gone.
  assert.ok(
    !/baseRows\.filter\(\s*\(r\)\s*=>\s*r\.status/.test(src),
    "videos page must no longer narrow baseRows by status in JS — the filter moved to the WHERE",
  );
  assert.match(
    src,
    /eq\(videoSubmissions\.status,/,
    "videos page must filter status server-side",
  );
  assert.match(
    src,
    /eq\(videoSubmissions\.source,/,
    "videos page must filter source server-side",
  );
  assert.match(src, /name="source"/, "videos page must expose a 'source' select for the ingest channel");
  // Per-status counts come from GROUP BY.
  assert.match(
    src,
    /\.groupBy\(videoSubmissions\.status\)/,
    "videos page must roll up per-status counts via GROUP BY",
  );
});

test("spec 129 — /mentorship adds a server-side status filter with per-status counts", () => {
  const src = read(MENTORSHIP);
  assert.match(src, /searchParams/, "mentorship page must accept searchParams");
  assert.match(
    src,
    /eq\(mentorPairings\.status,/,
    "mentorship page must filter pairing status server-side",
  );
  // Counts via GROUP BY.
  assert.match(
    src,
    /\.groupBy\(mentorPairings\.status\)/,
    "mentorship page must roll up per-status counts via GROUP BY",
  );
  // Status chip strip — six chips total per the spec (all + 5 statuses).
  assert.match(src, /STATUS_TABS/, "mentorship page must declare a STATUS_TABS const for the chip strip");
});

test("spec 129 — no page introduces a 'use client' directive on the affected files", () => {
  for (const p of ALL_PAGES) {
    const src = read(p);
    assert.ok(
      !/^\s*["']use client["']/m.test(src),
      `${p} must stay a pure server component`,
    );
  }
});

test("spec 129 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const p of ALL_PAGES) {
    const src = read(p);
    assert.ok(!/\bTODO\b/i.test(src), `${p} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${p} must not contain FIXME markers`);
  }
});

test("spec 129 — each affected page uses an `and(...)` Drizzle WHERE composition", () => {
  // Validate that the multi-predicate pages compose via `and(...)`.
  // observation / outlines / sessions / teachers / mentorship can stack
  // multiple filters; schools also stacks `eq(schools.active, true)` with
  // the district predicate.
  for (const p of [OBSERVATION, OUTLINES, SESSIONS, TEACHERS, MENTORSHIP, SCHOOLS, SUBJECTS, VIDEOS]) {
    const src = read(p);
    assert.match(
      src,
      /\band\(/,
      `${p} must compose its WHERE predicates via Drizzle's and(...) helper`,
    );
  }
});
