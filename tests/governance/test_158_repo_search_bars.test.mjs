// Governance test for spec 158 — Inline name-search bars on every
// /repo/* index (Workflow Run 15 audit-closure, MISS severity).
//
// Seven repo index pages under audit. Each adds a single `?q=` URL
// search parameter that ILIKE-narrows the listing on the primary
// name column, combines with existing filters via `and(...)`, renders
// an inline `<input type="search" name="q">` form control, and a
// Clear link gated on `qFilter`.
//
// Column → predicate map:
//   /repo/schools    → schools.name
//   /repo/teachers   → teachers.fullName
//   /repo/mentors    → mentors.name
//   /repo/subjects   → subjects.name
//   /repo/sessions   → sessions.topic
//   /repo/resources  → resources.name
//   /repo/outlines   → courseOutlines.name
//
// Plus the five spec-kit files under specs/158-repo-search-bars/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCHOOLS_PATH = "apps/web/src/app/(authenticated)/repo/schools/page.tsx";
const TEACHERS_PATH = "apps/web/src/app/(authenticated)/repo/teachers/page.tsx";
const MENTORS_PATH = "apps/web/src/app/(authenticated)/repo/mentors/page.tsx";
const SUBJECTS_PATH = "apps/web/src/app/(authenticated)/repo/subjects/page.tsx";
const SESSIONS_PATH = "apps/web/src/app/(authenticated)/repo/sessions/page.tsx";
const RESOURCES_PATH = "apps/web/src/app/(authenticated)/repo/resources/page.tsx";
const OUTLINES_PATH = "apps/web/src/app/(authenticated)/repo/outlines/page.tsx";
const SPEC_DIR = "specs/158-repo-search-bars";

const ALL_PAGES = [
  ["schools", SCHOOLS_PATH, "schools.name", "Search schools by name"],
  ["teachers", TEACHERS_PATH, "teachers.fullName", "Search teachers by name"],
  ["mentors", MENTORS_PATH, "mentors.name", "Search mentors by name"],
  ["subjects", SUBJECTS_PATH, "subjects.name", "Search subjects by name"],
  ["sessions", SESSIONS_PATH, "sessions.topic", "Search sessions by topic"],
  ["resources", RESOURCES_PATH, "resources.name", "Search resources by name"],
  ["outlines", OUTLINES_PATH, "courseOutlines.name", "Search outlines by name"],
];

// ---------- Spec-kit + plan.md contract ----------

test("spec 158 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the repo-search-bars spec`,
    );
  }
});

test("spec 158 — plan.md follows the CREATED/EDITED/MIGRATED contract and names every edited page", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // All seven edited pages must be named in plan.md so a reader auditing
  // the contract knows where the surface area lives.
  for (const file of [
    "schools/page.tsx",
    "teachers/page.tsx",
    "mentors/page.tsx",
    "subjects/page.tsx",
    "sessions/page.tsx",
    "resources/page.tsx",
    "outlines/page.tsx",
  ]) {
    assert.match(
      src,
      new RegExp(file.replace(/[/.]/g, "\\$&")),
      `plan.md must call out the ${file} edit so the surface is discoverable`,
    );
  }
});

// ---------- One assertion per page ----------
// Each of the 7 pages gets a single test that walks the contract end to
// end (SearchParams shape + ILIKE predicate + form control + Clear link).
// This satisfies the spec's "8+ assertions, one per page" requirement
// while keeping per-page failures isolated.

for (const [label, path, column, ariaLabel] of ALL_PAGES) {
  test(`spec 158 — /repo/${label} carries the full ?q= search contract`, () => {
    const src = read(path);

    // (1) `q?: string` on the SearchParams Promise type. We allow
    // either an inline `Promise<{...; q?: string}>` shape or a named
    // `type SearchParams = Promise<{...; q?: string}>`.
    assert.match(
      src,
      /q\?\s*:\s*string/,
      `${path} must declare \`q?: string\` on its SearchParams type so the search param typechecks`,
    );

    // (2) The literal ILIKE predicate against the spec'd name column.
    // Drizzle's ilike builder takes (column, pattern) — we pin the column
    // reference, the pattern wraps the user input via escapeIlike + %.
    const colRegex = new RegExp(
      `ilike\\(\\s*${column.replace(/\./g, "\\.")}\\s*,\\s*\`%\\$\\{escapeIlike\\(qFilter\\)\\}%\``,
    );
    assert.match(
      src,
      colRegex,
      `${path} must call ilike(${column}, \`%\${escapeIlike(qFilter)}%\`) so the user query maps to a substring match on the canonical name column`,
    );

    // (3) The 200-char cap as a literal constant. Pinning the literal
    // 200 so a future contributor can't silently bump it (which would
    // open a DoS surface — a 10MB query string would let an attacker
    // OOM the planner with a giant ILIKE pattern).
    assert.match(
      src,
      /SEARCH_Q_MAX\s*=\s*200/,
      `${path} must cap the search input at SEARCH_Q_MAX = 200 chars so a giant pasted blob doesn't bloat the URL or stress the planner`,
    );

    // (4) escapeIlike — ONE SHARED IMPLEMENTATION, imported.
    //
    // This used to require each page to DECLARE its own
    // `function escapeIlike(s: string)` and to pin all three .replace calls
    // verbatim, in all eight files. That is how the bug happened: the eight
    // copies stayed correct and /api/quickfind -- the one endpoint that fans
    // eight leading-wildcard searches across the staff and school roster on
    // every keystroke -- was never given a copy at all, so `?q=%` returned the
    // entire roster. A test that mandates duplication cannot notice the place
    // that was left out of it.
    //
    // Pinned now: each page imports the shared helper and uses it in the
    // pattern. The escaping itself is pinned once, below this loop, where it
    // lives.
    assert.match(
      src,
      /import \{ escapeIlike \} from "@gml\/shared\/sql\/ilike"/,
      `${path} must import the shared escapeIlike rather than declaring its own`,
    );
    assert.ok(
      !/function\s+escapeIlike/.test(src),
      `${path} must not re-declare escapeIlike -- one copy, shared`,
    );

    // (5) The input element — type="search", name="q", aria-label set
    // for screen readers, maxLength bound to the cap.
    assert.match(
      src,
      /type="search"\s+name="q"/,
      `${path} must render an <input type="search" name="q"> so the URL param key matches the SearchParams field`,
    );
    assert.match(
      src,
      new RegExp(`aria-label="${ariaLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `${path} input must carry aria-label="${ariaLabel}" so screen-reader users know what the field searches`,
    );
    assert.match(
      src,
      /maxLength\s*=\s*\{\s*SEARCH_Q_MAX\s*\}/,
      `${path} input must bind maxLength={SEARCH_Q_MAX} so the client-side cap mirrors the server-side slice`,
    );

    // (6) Clear link — gated on qFilter being truthy (either directly
    // as `qFilter ? <Link>...</Link>` or as part of an OR-expression
    // combining qFilter with other active filters). Either pattern
    // ensures an unfiltered view never renders a no-op Clear.
    assert.match(
      src,
      /qFilter[\)\s]*\?\s*\(?\s*<\s*Link/,
      `${path} must gate the Clear link on \`qFilter\` (or an OR-expression including qFilter) so an unfiltered view doesn't show a no-op Clear`,
    );

    // (7) qFilter derivation — trims whitespace and falls back to null.
    // Otherwise a user typing all-whitespace would set q to a value
    // that ilike(...) treats as a real (but matchless) pattern.
    assert.match(
      src,
      /qRaw\.trim\(\)\.length\s*>\s*0\s*\?\s*qRaw\.trim\(\)\s*:\s*null/,
      `${path} must derive qFilter as \`qRaw.trim().length > 0 ? qRaw.trim() : null\` so all-whitespace queries behave as absent`,
    );

    // (8) and(...) combination — the new ILIKE predicate must combine
    // with existing filters via and(...), not replace them.
    assert.match(
      src,
      /\band\(/,
      `${path} must combine the new ILIKE predicate with existing filters via and(...) — the search must not silently drop the active district/grade/status/kind filter`,
    );

    // (9) Inline Spec 158 reference so a future contributor reading the
    // file knows where the contract lives.
    assert.match(
      src,
      /Spec 158/,
      `${path} must carry an inline \`Spec 158\` comment so the search bar is self-documenting`,
    );
  });
}

// ---------- Cross-page hygiene ----------

test("spec 158 — every edited page imports drizzle's ilike", () => {
  // The ILIKE predicate requires drizzle-orm's `ilike` builder. Each
  // page must import it or the predicate won't compile.
  for (const [label, path] of ALL_PAGES) {
    const src = read(path);
    assert.match(
      src,
      /from\s+"drizzle-orm"/,
      `${path} (/${label}) must import from "drizzle-orm" so ilike() resolves`,
    );
    assert.match(
      src,
      /\bilike\b/,
      `${path} (/${label}) must reference ilike — the predicate name is the contract`,
    );
  }
});

test("spec 158 — no client-component creep (no 'use client', no useState)", () => {
  // The spec is explicitly server-side via native GET form. A future
  // contributor adding instant-search via React state would break the
  // URL-as-source-of-truth contract.
  for (const [label, path] of ALL_PAGES) {
    const src = read(path);
    assert.ok(
      !/"use client"/.test(src),
      `${path} (/${label}) must NOT declare "use client" — search is server-side via native GET form`,
    );
    assert.ok(
      !/\buseState\b/.test(src),
      `${path} (/${label}) must NOT use useState — the URL is the source of truth for the search state`,
    );
  }
});

test("spec 158 — no new dependencies were introduced", () => {
  // The fix is pure WHERE-clause + DOM additions. No fuzzy-search lib,
  // no client-side debounce hook should creep into apps/web/package.json.
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/"use-debounce"/.test(pkg),
    "apps/web must not depend on use-debounce — the search is a native GET form, no debounce needed",
  );
  assert.ok(
    !/"fuse\.js"/.test(pkg),
    "apps/web must not depend on fuse.js — the search is server-side ILIKE, no client-side fuzzy match",
  );
});

test("spec 158 — no TODO / FIXME markers leaked into shipped source", () => {
  for (const [label, path] of ALL_PAGES) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} (/${label}) must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} (/${label}) must not contain FIXME markers`);
  }
});

test("spec 158 — native HTML method='GET' form submission across all 7 pages", () => {
  // The form MUST submit via GET so the URL is the source of truth and
  // shareable. A POST form would lose this property.
  for (const [label, path] of ALL_PAGES) {
    const src = read(path);
    assert.match(
      src,
      /method="GET"/,
      `${path} (/${label}) must use <form method="GET"> so the search URL is shareable`,
    );
  }
});

test("spec 158 — /repo/students name-search is allowed ONLY when audit dedup is wired", () => {
  // SM-9 audits every render of /repo/students; adding an un-deduped search
  // would flood the audit log (a user typing "kunzang" letter-by-letter
  // produces 7 audit rows). Originally this assertion pinned the absence of
  // the ilike-on-name predicate entirely. Spec 168 (half-wired-features-
  // finish) added the search anyway and protects the audit log via
  // recordAuditDedup — one row per (user × query × hour). This test now
  // enforces the LOOSENED contract: the page MAY carry an ilike on
  // learners.name, but ONLY IF it also calls recordAuditDedup (or doesn't
  // carry the search at all). A future contributor who adds the search
  // without the dedup helper still gets a red light first.
  const STUDENTS_PATH = "apps/web/src/app/(authenticated)/repo/students/page.tsx";
  const src = read(STUDENTS_PATH);
  const hasIlikeOnName = /ilike\(\s*learners\.name/.test(src);
  const hasAuditDedup = /recordAuditDedup\s*\(/.test(src);
  assert.ok(
    !hasIlikeOnName || hasAuditDedup,
    "/repo/students may carry ilike(learners.name, …) ONLY when recordAuditDedup is also called (spec 168) — adding the search without dedup floods the SM-9 audit log",
  );
});

test("spec 158 — the shared escapeIlike escapes backslash first, then % and _", () => {
  // The escaping contract itself, checked once in the module that owns it.
  //
  // Asserted by literal substring rather than by regex: the thing under test is
  // itself a set of backslash escapes, and a regex describing it needs four
  // levels of escaping to say anything at all. A wrong regex here would fail
  // open, which is the one outcome this must not have.
  const src = read("packages/shared/src/sql/ilike.ts");
  const backslashFirst = ".replace(/\\\\/g, \"\\\\\\\\\")";
  const percent = ".replace(/%/g, \"\\\\%\")";
  const underscore = ".replace(/_/g, \"\\\\_\")";
  assert.ok(src.includes(backslashFirst), `escapeIlike must double the backslash: ${backslashFirst}`);
  assert.ok(src.includes(percent), `escapeIlike must escape %: ${percent}`);
  assert.ok(src.includes(underscore), `escapeIlike must escape _: ${underscore}`);
  // ORDER IS LOAD-BEARING. Backslashes must be doubled BEFORE % and _ are
  // escaped, or the escapes introduced for those would themselves be escaped.
  assert.ok(
    src.indexOf(backslashFirst) < src.indexOf(percent) &&
      src.indexOf(backslashFirst) < src.indexOf(underscore),
    "the backslash replacement must come first",
  );
});

test("spec 158 — /api/quickfind escapes its query too", () => {
  // The endpoint the eight-copy contract left out. It interpolated the raw
  // query into an ILIKE pattern across eight tables, so `?q=%` dumped the
  // staff and school roster to any signed-in user.
  const src = read("apps/web/src/app/api/quickfind/route.ts");
  assert.match(
    src,
    /import \{ escapeIlike \} from "@gml\/shared\/sql\/ilike"/,
    "quickfind must import the shared escapeIlike",
  );
  assert.match(
    src,
    /`%\$\{escapeIlike\(rawQ\)\}%`/,
    "quickfind must escape the user query before building the ILIKE pattern",
  );
});
