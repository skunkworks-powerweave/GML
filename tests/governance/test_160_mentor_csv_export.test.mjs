// Governance test for spec 160 — Mentor CSV export
// (Workflow Run 15 audit-closure, MISS severity).
//
// Two files under audit:
//
//   1. apps/web/src/app/api/admin/data/mentors/export/route.ts (CREATED)
//      — GET handler that joins mentor_pairings filtered to
//        status="active", emits a six-column CSV (id, name,
//        hindiName, baseLocation, expertiseAreas (JSON-stringified),
//        pairingsActive), with super_admin OR programme_admin role
//        gate, JSON 401/403/405 method matrix, audit row written
//        AFTER the SELECT.
//
//   2. apps/web/src/app/(authenticated)/repo/mentors/page.tsx (EDITED)
//      — adds a `Download CSV` anchor in the page header gated on
//        super_admin OR programme_admin, pointed at the new route,
//        carries data-testid="mentors-csv-export".
//
// Plus the five spec-kit files under specs/160-mentor-csv-export/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/admin/data/mentors/export/route.ts";
const PAGE_PATH = "apps/web/src/app/(authenticated)/repo/mentors/page.tsx";
const SPEC_DIR = "specs/160-mentor-csv-export";

// ---------- Spec-kit + plan.md contract ----------

test("spec 160 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mentor-csv-export spec`,
    );
  }
});

test("spec 160 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // Both touched files must be named in plan.md so a reader auditing
  // the contract knows where the surface area actually lives.
  assert.match(
    src,
    /api\/admin\/data\/mentors\/export\/route\.ts/,
    "plan.md must name the new route file under CREATED",
  );
  assert.match(
    src,
    /repo\/mentors\/page\.tsx/,
    "plan.md must name the edited page file under EDITED",
  );
});

// ---------- (1) Route file exists ----------

test("spec 160 — the mentor export route file exists", () => {
  assert.ok(
    existsSync(resolve(root, ROUTE_PATH)),
    `${ROUTE_PATH} must exist — the route is the download target for the page-header button`,
  );
});

// ---------- (2) Route exports the expected handlers ----------

test("spec 160 — route exports a GET handler", () => {
  const src = read(ROUTE_PATH);
  // The GET handler is the actual export endpoint. Without this the
  // page-header button would 404.
  assert.match(
    src,
    /export\s+async\s+function\s+GET\s*\(/,
    "route.ts must export an async GET function — the page-header button hits GET on this URL",
  );
});

test("spec 160 — route exports 405 handlers for POST, PUT, DELETE, PATCH", () => {
  const src = read(ROUTE_PATH);
  // The method matrix MUST be complete — pre-spec a POST/PUT/etc. would
  // 404 from Next's router; with explicit handlers each non-GET verb
  // returns 405 JSON, which is the documented Next.js convention.
  for (const verb of ["POST", "PUT", "DELETE", "PATCH"]) {
    assert.match(
      src,
      new RegExp(`export\\s+async\\s+function\\s+${verb}\\s*\\(`),
      `route.ts must export a ${verb} handler so the method matrix is complete`,
    );
  }
  // The 405 body MUST be the documented shape — at least 4 occurrences
  // of the literal method_not_allowed error, one per non-GET handler.
  const matches = src.match(/method_not_allowed/g) ?? [];
  assert.ok(
    matches.length >= 4,
    `route.ts must return {error:"method_not_allowed"} from each non-GET handler — found ${matches.length} occurrences, expected at least 4`,
  );
});

// ---------- (3) Auth + role gate ----------

test("spec 160 — GET handler returns 401 JSON on unauthenticated requests", () => {
  const src = read(ROUTE_PATH);
  // The 401 path MUST be a JSON response, not a redirect — API routes
  // never redirect (the caller is a programmatic <a href> or fetch).
  // The pre-spec generic export at csv.ts uses requireRole which DOES
  // redirect; this dedicated route deliberately diverges per the audit
  // closure spec.
  assert.match(
    src,
    /NextResponse\.json\(\s*\{\s*error:\s*"unauthenticated"\s*\}\s*,\s*\{\s*status:\s*401\s*\}\s*\)/,
    'GET handler must return NextResponse.json({error:"unauthenticated"}, {status:401}) when there is no session',
  );
});

test("spec 160 — GET handler gates to super_admin OR programme_admin and returns 403 JSON otherwise", () => {
  const src = read(ROUTE_PATH);
  // The allowlist MUST contain both roles. Pre-spec there was no route
  // at all; ensuring both roles get through is what allows the
  // /repo/mentors page button to be visible to programme_admin too.
  assert.match(
    src,
    /ALLOWED_ROLES\s*=\s*\[\s*"super_admin"\s*,\s*"programme_admin"\s*\]/,
    'route.ts must declare ALLOWED_ROLES = ["super_admin", "programme_admin"] so both admin roles can export but mentor cannot',
  );
  // The 403 response MUST be JSON shape — same reason as the 401.
  assert.match(
    src,
    /NextResponse\.json\(\s*\{\s*error:\s*"forbidden"\s*\}\s*,\s*\{\s*status:\s*403\s*\}\s*\)/,
    'GET handler must return NextResponse.json({error:"forbidden"}, {status:403}) when the role is outside the allowlist',
  );
});

// ---------- (4) SELECT shape — six columns + active-pairings join ----------

test("spec 160 — SELECT projects the six audit-closure columns", () => {
  const src = read(ROUTE_PATH);
  // Each of the six columns must appear in the SELECT shape — pinning
  // them individually means a future contributor can't silently drop
  // one (e.g. `expertiseAreas` because it's awkward jsonb).
  for (const col of [
    "id: mentors.id",
    "name: mentors.name",
    "hindiName: mentors.hindiName",
    "baseLocation: mentors.baseLocation",
    "expertiseAreas: mentors.expertiseAreas",
  ]) {
    assert.ok(
      src.includes(col),
      `route.ts SELECT must project ${col} — that's an audit-closure column`,
    );
  }
  // The pairings count is a join projection, not a direct column.
  assert.match(
    src,
    /pairingsActive:\s*pairingCounts\.pairingsActive/,
    "route.ts SELECT must project pairingsActive from the pairing_counts subquery",
  );
});

test("spec 160 — mentor_pairings join filters to status='active'", () => {
  const src = read(ROUTE_PATH);
  // The active-only predicate is what makes the count match the on-page
  // mentee count. Lifetime pairings would inflate the export.
  assert.match(
    src,
    /eq\(\s*mentorPairings\.status\s*,\s*"active"\s*\)/,
    'route.ts pairings join must filter to eq(mentorPairings.status, "active") so the count matches the on-page mentee count',
  );
  // The join must be a LEFT JOIN so mentors with zero active pairings
  // still appear in the export (they'd otherwise be silently dropped
  // by an INNER JOIN with the count subquery).
  assert.match(
    src,
    /\.leftJoin\(\s*pairingCounts\s*,/,
    "route.ts must use leftJoin against the pairing_counts subquery so mentors with zero active pairings still appear in the export",
  );
});

// ---------- (5) Audit row ----------

test("spec 160 — audit row uses action='mentors.bulk_export' and runs after the SELECT", () => {
  const src = read(ROUTE_PATH);
  // The audit action key MUST match the documented dotted convention
  // (`entity.bulk_export`) so the audit log's action-prefix indexes
  // can group mentors-export rows together.
  assert.match(
    src,
    /action:\s*"mentors\.bulk_export"/,
    'route.ts must call recordAudit with action: "mentors.bulk_export" so the audit log surface matches the documented convention',
  );
  // rowCount MUST be derived from the SELECT result, not hard-coded.
  // The metadata.rowCount field is what the auditor uses to scope
  // post-incident damage assessment.
  assert.match(
    src,
    /rowCount:\s*rows\.length/,
    "route.ts must set metadata.rowCount = rows.length so the audit row reflects the actual exfiltrated count",
  );
  // The recordAudit call MUST appear AFTER the await on the SELECT
  // that produces `rows`. We pin this by checking that the source
  // ordering puts `const rows = await db` before the `void recordAudit`
  // invocation (the head-of-file docstring also mentions recordAudit
  // and an `await db` for the subquery, so we anchor on the exact
  // production-code shapes).
  const selectIdx = src.indexOf("const rows = await db");
  // Anchor on `void recordAudit({` (open brace) so the docstring's
  // bare `void recordAudit(...)` mention doesn't false-positive.
  const auditIdx = src.indexOf("void recordAudit({");
  assert.ok(
    selectIdx > -1 && auditIdx > -1 && selectIdx < auditIdx,
    "void recordAudit must be called AFTER `const rows = await db` so rowCount = rows.length is accurate (selectIdx=" +
      selectIdx +
      ", auditIdx=" +
      auditIdx +
      ")",
  );
});

test("spec 160 — recordAudit is fire-and-forget so audit failure does not block the 200", () => {
  const src = read(ROUTE_PATH);
  // The `void recordAudit(...)` pattern — not `await` — is the
  // documented best-effort convention (mirrors the learners export).
  // Without this an audit-channel hiccup would block the user-facing
  // CSV download, which violates the contract.
  assert.match(
    src,
    /void\s+recordAudit\(/,
    "route.ts must use `void recordAudit(...)` (not await) so an audit-channel hiccup never blocks the user-facing 200",
  );
});

// ---------- (6) CSV response shape ----------

test("spec 160 — response carries text/csv content-type and attachment disposition", () => {
  const src = read(ROUTE_PATH);
  // The Content-Type MUST be text/csv so the browser triggers a
  // download instead of rendering inline.
  assert.match(
    src,
    /"Content-Type":\s*"text\/csv;\s*charset=utf-8"/,
    'route.ts must set Content-Type: "text/csv; charset=utf-8" so the browser treats the body as a downloadable CSV',
  );
  // The filename MUST follow the documented "mentors-YYYY-MM-DD.csv"
  // pattern (matches the generic export at csv.ts line 55). Use a
  // non-greedy `.*?` between Content-Disposition and attachment so the
  // intervening punctuation (`":` + backtick) is consumed.
  assert.match(
    src,
    /Content-Disposition.*?attachment;\s*filename="\$\{filename\}"/,
    'route.ts must set Content-Disposition: attachment with the filename template — the browser uses this to name the saved file',
  );
  assert.match(
    src,
    /mentors-\$\{new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)\}\.csv/,
    'route.ts filename must follow the "mentors-YYYY-MM-DD.csv" pattern using the UTC date prefix',
  );
});

test("spec 160 — CSV headers row contains all six column keys in order", () => {
  const src = read(ROUTE_PATH);
  // The header order is part of the contract — operators who script
  // against the CSV expect a stable column order.
  assert.match(
    src,
    /const\s+headers\s*=\s*\[\s*"id"\s*,\s*"name"\s*,\s*"hindiName"\s*,\s*"baseLocation"\s*,\s*"expertiseAreas"\s*,\s*"pairingsActive"\s*\]/,
    'route.ts must declare headers = ["id", "name", "hindiName", "baseLocation", "expertiseAreas", "pairingsActive"] in that exact order — operators script against this column layout',
  );
});

// ---------- (7) Page header — Download CSV button ----------

test("spec 160 — /repo/mentors page renders a Download CSV anchor pointing at the new route", () => {
  const src = read(PAGE_PATH);
  // The button must point at the new route — without this the page-
  // header surface would be a stub that doesn't actually call the API.
  assert.match(
    src,
    /href="\/api\/admin\/data\/mentors\/export"/,
    'mentors/page.tsx must render an anchor with href="/api/admin/data/mentors/export" — the button is the entry point to the new route',
  );
  // The button label MUST be the documented "Download CSV" string —
  // matches the audit-closure spec language and is what operators look
  // for. (The /repo/students page uses "Export CSV"; the audit closure
  // explicitly asked for "Download CSV" here.)
  assert.match(
    src,
    />\s*Download CSV\s*</,
    'mentors/page.tsx anchor label must be "Download CSV" — matches the audit-closure spec language',
  );
  // The data-testid carries the integration-test hook so future
  // Playwright suites can scrape the element without fragile selectors.
  assert.match(
    src,
    /data-testid="mentors-csv-export"/,
    'mentors/page.tsx anchor must carry data-testid="mentors-csv-export" so integration tests can scrape it',
  );
});

test("spec 160 — /repo/mentors page gates the Download CSV button on super_admin OR programme_admin", () => {
  const src = read(PAGE_PATH);
  // The canExport derivation must be present — without it the button
  // would render for the `mentor` role too, surfacing a dead link
  // (the route would 403 them).
  assert.match(
    src,
    /canExport\s*=\s*[\s\S]{0,500}"super_admin"[\s\S]{0,200}"programme_admin"/,
    'mentors/page.tsx must derive a `canExport` boolean from session.user.role checking for "super_admin" || "programme_admin" so the button hides for the mentor role',
  );
  // The button render MUST be gated on `canExport` — without the
  // gate the derivation is dead code and the button leaks.
  assert.match(
    src,
    /\{canExport\s*\?[\s\S]{0,1500}Download CSV/,
    "mentors/page.tsx must wrap the Download CSV anchor in a `{canExport ? ... : null}` ternary so the button only renders for allowed roles",
  );
});

// ---------- (8) No-regression / hygiene ----------

test("spec 160 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [ROUTE_PATH, PAGE_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 160 — no new dependencies were introduced", () => {
  // The fix reuses papaparse, drizzle, and next/server — all already
  // workspace deps. No new package should have crept into
  // apps/web/package.json as a side-effect.
  const pkg = read("apps/web/package.json");
  // Spot-checks against plausible accidental additions (csv-stringify,
  // fast-csv, etc.) — the spec's stated contract is "no new deps".
  assert.ok(
    !/"csv-stringify"/.test(pkg),
    "apps/web must not depend on csv-stringify — the mentor export reuses Papa.unparse like the learners export",
  );
  assert.ok(
    !/"fast-csv"/.test(pkg),
    "apps/web must not depend on fast-csv — same reason",
  );
});

test("spec 160 — route file carries an inline Spec 160 reference so the new file is self-documenting", () => {
  const src = read(ROUTE_PATH);
  // Soft contract — every previous LMS hardening / closure fix has
  // carried an inline spec reference so a future contributor reading
  // the file knows to consult the spec before reverting.
  assert.match(
    src,
    /Spec 160/,
    "route.ts must carry an inline `Spec 160` reference so the file's provenance is self-documenting",
  );
});

test("spec 160 — page file carries an inline Spec 160 reference for the new button", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /Spec 160/,
    "mentors/page.tsx must carry an inline `Spec 160` comment so the Download CSV button addition is self-documenting",
  );
});
