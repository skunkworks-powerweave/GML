// Governance test for spec 121 — Workflow Run 10 QuickFind ⌘K revival.
//
// Verifies:
//   1. All five spec-kit files exist; plan.md follows the CREATED/EDITED/MIGRATED contract.
//   2. /api/quickfind/route.ts exists, exports a GET handler, is auth() gated,
//      walks the 8 documented entities with ilike, returns a flat results array,
//      caps at HARD_CAP, and writes the quickfind.query audit row.
//   3. /components/quickfind/QuickFind.tsx is a "use client" component that
//      attaches a single keydown listener (Cmd+K / Ctrl+K) and cleans it up
//      on unmount, closes on Esc / background / select, debounces fetches to
//      /api/quickfind, supports keyboard nav (ArrowDown/ArrowUp/Enter), and
//      persists a 5-item recents list to localStorage keyed by user id.
//   4. (authenticated)/layout.tsx mounts <QuickFind userId={user.id} />.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SPEC_DIR = "specs/121-quick-find-cmdk";
const ROUTE = "apps/web/src/app/api/quickfind/route.ts";
const COMPONENT = "apps/web/src/components/quickfind/QuickFind.tsx";
const LAYOUT = "apps/web/src/app/(authenticated)/layout.tsx";

test("Spec 121: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the QuickFind revival spec`,
    );
  }
});

test("Spec 121: plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /api\/quickfind\/route\.ts/,
    "plan.md must call out the API route under CREATED",
  );
  assert.match(
    src,
    /quickfind\/QuickFind\.tsx/,
    "plan.md must call out the client component under CREATED",
  );
  assert.match(
    src,
    /\(authenticated\)\/layout\.tsx/,
    "plan.md must call out the layout in EDITED",
  );
  assert.match(
    src,
    /MIGRATED:\s*none/i,
    "plan.md must declare MIGRATED: none — no schema additions",
  );
});

test("Spec 121: API route exists and is auth-gated GET handler", () => {
  assert.ok(existsSync(resolve(root, ROUTE)), `${ROUTE} must exist`);
  const src = read(ROUTE);
  assert.match(
    src,
    /export\s+async\s+function\s+GET\(/,
    "route.ts must export a GET handler",
  );
  assert.match(
    src,
    /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/,
    "route.ts must import auth from @/auth for the session gate",
  );
  assert.match(
    src,
    /session\?\.user\?\.id/,
    "route.ts must guard against a missing session.user.id",
  );
  assert.match(
    src,
    /unauthenticated/,
    "route.ts must return an unauthenticated error when there is no session",
  );
});

test("Spec 121: API route enforces a minimum query length", () => {
  const src = read(ROUTE);
  // The minimum query constant + the short-circuit branch must both be present.
  assert.match(
    src,
    /MIN_QUERY\s*=\s*2/,
    "route.ts must declare MIN_QUERY = 2 — short queries short-circuit to []",
  );
  assert.match(
    src,
    /length\s*<\s*MIN_QUERY/,
    "route.ts must short-circuit when q.length < MIN_QUERY",
  );
});

test("Spec 121: API route fans out to all 8 documented entities via ilike", () => {
  const src = read(ROUTE);
  // The drizzle ilike import…
  assert.match(
    src,
    /import\s*\{[^}]*\bilike\b[^}]*\}\s*from\s*"drizzle-orm"/,
    "route.ts must import `ilike` from drizzle-orm",
  );
  // …and the schema imports must include every fanned-out table.
  for (const tbl of [
    "teachers",
    "schools",
    "classes",
    "subjects",
    "observationCycles",
    "mentorPairings",
    "mentors",
    "courseOutlines",
    "sessions",
  ]) {
    const re = new RegExp(`import\\s*\\{[\\s\\S]*?\\b${tbl}\\b[\\s\\S]*?\\}\\s*from\\s*"@gml/db/schema"`);
    assert.match(src, re, `route.ts must import \`${tbl}\` from @gml/db/schema`);
  }
  // Schools must use both name and code (OR) — the audit-trail prose calls this out.
  assert.match(
    src,
    /ilike\(\s*schools\.name\s*,/,
    "route.ts must ilike on schools.name",
  );
  assert.match(
    src,
    /ilike\(\s*schools\.code\s*,/,
    "route.ts must ilike on schools.code",
  );
  // Subjects must do the same.
  assert.match(
    src,
    /ilike\(\s*subjects\.name\s*,/,
    "route.ts must ilike on subjects.name",
  );
  assert.match(
    src,
    /ilike\(\s*subjects\.code\s*,/,
    "route.ts must ilike on subjects.code",
  );
});

test("Spec 121: API route returns a flat results array capped at HARD_CAP=20", () => {
  const src = read(ROUTE);
  assert.match(
    src,
    /HARD_CAP\s*=\s*20/,
    "route.ts must declare HARD_CAP = 20",
  );
  // The cap is applied via slice before the JSON response is built.
  assert.match(
    src,
    /\.slice\(\s*0\s*,\s*HARD_CAP\s*\)/,
    "route.ts must slice the merged results to HARD_CAP entries",
  );
  // The response shape includes a `results` key (flat array contract).
  assert.match(
    src,
    /results:\s*capped|results:\s*\[/,
    "route.ts must return `results: …` in the JSON body",
  );
});

test("Spec 121: API route writes a quickfind.query audit row with q + resultCount", () => {
  const src = read(ROUTE);
  assert.match(
    src,
    /import\s*\{\s*recordAudit\s*\}\s*from\s*"@\/lib\/audit"/,
    "route.ts must import recordAudit from @/lib/audit",
  );
  assert.match(
    src,
    /action:\s*"quickfind\.query"/,
    "route.ts must audit action='quickfind.query'",
  );
  assert.match(
    src,
    /resultCount/,
    "route.ts must include resultCount in the audit metadata",
  );
  // Best-effort `void` so the audit-log failure never blocks the user-facing 200.
  assert.match(
    src,
    /void\s+recordAudit\(/,
    "route.ts must `void recordAudit(...)` — audit insert must not block the 200",
  );
});

test("Spec 121: API route returns 405 for non-GET methods", () => {
  const src = read(ROUTE);
  for (const verb of ["POST", "PUT", "DELETE", "PATCH"]) {
    const re = new RegExp(`export\\s+async\\s+function\\s+${verb}\\(`);
    assert.match(src, re, `route.ts must export a ${verb} handler that returns 405`);
  }
  assert.match(
    src,
    /method_not_allowed/,
    "route.ts must emit the method_not_allowed error code on disallowed verbs",
  );
});

test("Spec 121: QuickFind.tsx is a 'use client' component", () => {
  assert.ok(existsSync(resolve(root, COMPONENT)), `${COMPONENT} must exist`);
  const src = read(COMPONENT);
  assert.match(
    src,
    /^["']use client["']/,
    "QuickFind.tsx must start with 'use client' — the listener + state need a client boundary",
  );
});

test("Spec 121: QuickFind.tsx attaches a single keydown listener and cleans up", () => {
  const src = read(COMPONENT);
  assert.match(
    src,
    /window\.addEventListener\(\s*"keydown"/,
    "QuickFind.tsx must register a window-scope keydown listener",
  );
  assert.match(
    src,
    /window\.removeEventListener\(\s*"keydown"/,
    "QuickFind.tsx must remove the keydown listener on unmount (no leak)",
  );
  // Cmd+K / Ctrl+K must both trigger the toggle.
  assert.match(
    src,
    /metaKey\s*\|\|\s*event\.ctrlKey|event\.metaKey\s*\|\|\s*event\.ctrlKey/,
    "QuickFind.tsx must accept both metaKey (mac) and ctrlKey (win/linux)",
  );
  // Esc must close the modal.
  assert.match(
    src,
    /"Escape"/,
    "QuickFind.tsx must close on Escape",
  );
});

test("Spec 121: QuickFind.tsx debounces fetches to /api/quickfind", () => {
  const src = read(COMPONENT);
  assert.match(
    src,
    /DEBOUNCE_MS\s*=\s*\d+/,
    "QuickFind.tsx must declare a DEBOUNCE_MS constant",
  );
  assert.match(
    src,
    /\/api\/quickfind\?q=/,
    "QuickFind.tsx must fetch /api/quickfind?q=...",
  );
  assert.match(
    src,
    /encodeURIComponent/,
    "QuickFind.tsx must URL-encode the query string",
  );
  assert.match(
    src,
    /setTimeout/,
    "QuickFind.tsx must defer the fetch via setTimeout for the debounce",
  );
});

test("Spec 121: QuickFind.tsx supports keyboard navigation (ArrowDown/ArrowUp/Enter)", () => {
  const src = read(COMPONENT);
  assert.match(
    src,
    /"ArrowDown"/,
    "QuickFind.tsx must handle ArrowDown to advance the highlight",
  );
  assert.match(
    src,
    /"ArrowUp"/,
    "QuickFind.tsx must handle ArrowUp to retreat the highlight",
  );
  assert.match(
    src,
    /"Enter"/,
    "QuickFind.tsx must handle Enter to select the highlighted row",
  );
});

test("Spec 121: QuickFind.tsx persists recents to localStorage keyed by user id", () => {
  const src = read(COMPONENT);
  assert.match(
    src,
    /localStorage/,
    "QuickFind.tsx must read/write localStorage for recents persistence",
  );
  assert.match(
    src,
    /gml\.quickfind\.recent\./,
    "QuickFind.tsx must use the 'gml.quickfind.recent.<uid>' storage key",
  );
  assert.match(
    src,
    /RECENTS_CAP\s*=\s*5/,
    "QuickFind.tsx must cap recents at 5 entries",
  );
});

test("Spec 121: QuickFind.tsx closes on background click (overlay onClick)", () => {
  const src = read(COMPONENT);
  // The outer overlay must be bound to a close handler; the inner card stops
  // propagation. Both halves must be present.
  //
  // This previously asserted the literal string `onClick={() => setOpen(false)}`.
  // That broke when the inline arrow was replaced by the `closePanel` callback --
  // a strictly better version that also clears the query, results and active
  // index instead of leaving them for an effect to reset on the next render.
  // The behaviour was preserved and improved; only the spelling changed. Match
  // the binding, not one way of writing it.
  assert.match(
    src,
    /onClick=\{\s*(?:closePanel|\(\)\s*=>\s*(?:closePanel\(\)|setOpen\(\s*false\s*\)))\s*\}/,
    "QuickFind.tsx outer overlay must be bound to a close handler",
  );
  assert.match(
    src,
    /stopPropagation/,
    "QuickFind.tsx inner card must stopPropagation so clicks inside don't close the modal",
  );
});

test("Spec 121: (authenticated)/layout.tsx mounts <QuickFind userId={user.id} />", () => {
  const src = read(LAYOUT);
  assert.match(
    src,
    /import\s+QuickFind\s+from\s+"@\/components\/quickfind\/QuickFind"/,
    "layout.tsx must import QuickFind from @/components/quickfind/QuickFind",
  );
  assert.match(
    src,
    /<QuickFind\s+userId=\{user\.id\}/,
    "layout.tsx must render <QuickFind userId={user.id} /> so the shortcut works on every authenticated route",
  );
});

test("Spec 121: no TODO / FIXME / placeholder markers in shipped source", () => {
  for (const path of [ROUTE, COMPONENT]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
