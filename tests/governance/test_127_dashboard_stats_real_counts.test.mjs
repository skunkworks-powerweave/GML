// Governance test for spec 127 — Dashboard stats: real counts everywhere
// (Workflow Run 11 frontend-parity closure).
//
// Verifies that the JSX prototype's role-aware dashboards now ship with real
// user-scoped DB counts instead of hardcoded JSX literals. Eight focus areas:
//
//   1. The page is still a server component, force-dynamic, audit-traced.
//   2. Five distinct React.cache-wrapped chrome helpers exist
//      (getProgrammeChrome / getTeacherChrome / getObserverChrome /
//      getMentorChrome / getFieldMapSchools) and each runs its counts via
//      Promise.all for single-round-trip latency.
//   3. The teacher variant scopes counts to session.user.id with the four
//      labels the JSX prototype ships (My uploads / Cycles pending pre-form /
//      Cycles awaiting video / Open quizzes).
//   4. The mentor variant enforces the prototype's <48-hour SLA filter on
//      pending video reviews (context=teach_back AND status in 4-state set
//      AND created_at >= now() - 48h).
//   5. The observer variant scopes to observer_id and surfaces the three
//      labels the brief lists.
//   6. The super_admin variant adds the three extended cards (total users /
//      audit events 24h / storage MB).
//   7. The FieldMap renders a real db.select over schools with a /repo/school
//      deep link per dot, gated to programme + super admins only.
//   8. All five spec-kit files exist and plan.md follows the CREATED/EDITED/
//      MIGRATED contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/(authenticated)/dashboard/page.tsx";
const SPEC_DIR = "specs/127-dashboard-stats-real-counts";

test("spec 127 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the dashboard real-counts spec`,
    );
  }
});

test("spec 127 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /test_127_dashboard_stats_real_counts\.test\.mjs/,
    "plan.md must call out the new governance test in CREATED",
  );
  assert.match(
    src,
    /dashboard\/page\.tsx/,
    "plan.md must call out dashboard/page.tsx in EDITED",
  );
  assert.match(
    src,
    /none/,
    "plan.md MIGRATED line must say 'none' — this run is data-wiring-only per the brief",
  );
});

test("spec 127 — dashboard page stays a server component and is dynamic", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  const src = read(PAGE_PATH);
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "dashboard page must remain a pure server component — counts are server-side queries",
  );
  assert.match(
    src,
    /export const dynamic\s*=\s*"force-dynamic"/,
    "page must opt out of caching so fresh counts surface on every render",
  );
});

test("spec 127 — page imports React.cache and uses it on every chrome helper", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /import\s+\{\s*cache\s*\}\s+from\s+"react"/,
    "page must import cache from react so chrome helpers coalesce per-request",
  );
  // Each helper must be cache-wrapped — count the cache(async ( occurrences.
  const cacheCalls = src.match(/=\s*cache\(async\s*\(/g) ?? [];
  assert.ok(
    cacheCalls.length >= 5,
    `expected at least 5 React.cache-wrapped helpers (programme + teacher + observer + mentor + field-map); found ${cacheCalls.length}`,
  );
});

test("spec 127 — five chrome helpers are declared with the expected names", () => {
  const src = read(PAGE_PATH);
  for (const name of [
    "getProgrammeChrome",
    "getTeacherChrome",
    "getObserverChrome",
    "getMentorChrome",
    "getFieldMapSchools",
  ]) {
    assert.match(
      src,
      new RegExp(`const\\s+${name}\\s*=\\s*cache\\(`),
      `page must declare const ${name} = cache(...) so the helper is request-cached`,
    );
  }
});

test("spec 127 — every chrome helper fires its counts via Promise.all", () => {
  const src = read(PAGE_PATH);
  const promiseAllOccurrences = src.match(/Promise\.all\(/g) ?? [];
  // 4 chrome helpers (programme/teacher/observer/mentor) + the mentor-todo +
  // admin-todo helpers each use Promise.all = 6 expected. Floor at 4 to be
  // safe against future refactors that consolidate the todo helpers.
  assert.ok(
    promiseAllOccurrences.length >= 4,
    `expected at least 4 Promise.all batches; found ${promiseAllOccurrences.length}`,
  );
});

test("spec 127 — teacher variant scopes counts to session.user.id with the four prototype labels", () => {
  const src = read(PAGE_PATH);
  // The four labels the brief lists for the teacher variant.
  assert.match(src, /My uploads this week/, "teacher variant must render the 'My uploads this week' stat card");
  assert.match(src, /Cycles pending pre-form/, "teacher variant must render the 'Cycles pending pre-form' stat card");
  assert.match(src, /Cycles awaiting video/, "teacher variant must render the 'Cycles awaiting video' stat card");
  assert.match(src, /Open quizzes/, "teacher variant must render the 'Open quizzes' stat card");
  // The teacher chrome helper must scope on the session userId.
  assert.match(
    src,
    /getTeacherChrome\(session\.user\.id\)/,
    "teacher variant must pass session.user.id into getTeacherChrome — counts are user-scoped, not programme-wide",
  );
  // My-uploads filter on submittedByUserId so the count is mine, not the
  // programme's.
  assert.match(
    src,
    /eq\(videoSubmissions\.submittedByUserId,\s*userId\)/,
    "teacher variant must filter video_submissions by submittedByUserId = userId — not the programme-wide count",
  );
});

test("spec 127 — teacher open-quizzes filter uses NOT IN subquery against quiz_submissions", () => {
  const src = read(PAGE_PATH);
  // Active quizzes filter is the first half of the open-quizzes count.
  assert.match(
    src,
    /eq\(quizzes\.active,\s*true\)/,
    "open-quizzes count must filter on quizzes.active = true",
  );
  // NOT IN subquery against quiz_submissions for this user.
  assert.match(
    src,
    /NOT IN\s*\(/i,
    "open-quizzes count must use NOT IN to exclude quizzes the user has already submitted",
  );
  assert.match(
    src,
    /quizSubmissions\.quizId/,
    "open-quizzes subquery must select quizSubmissions.quizId so the NOT IN filter is correctly scoped",
  );
  assert.match(
    src,
    /quizSubmissions\.userId/,
    "open-quizzes subquery must filter on quizSubmissions.userId so the exclusion is per-user",
  );
});

test("spec 127 — mentor variant enforces the <48-hour SLA + 4-state status filter", () => {
  const src = read(PAGE_PATH);
  // 48-hour window — TWO_DAYS_MS is the canonical constant.
  assert.match(
    src,
    /TWO_DAYS_MS\s*=\s*48\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    "page must declare TWO_DAYS_MS = 48 hours so the mentor pending-review SLA is explicit",
  );
  // The four-state filter — received / queued / transcoding / review_pending.
  const m = src.match(/inArray\(videoSubmissions\.status,\s*\[([^\]]+)\]/);
  assert.ok(m, "mentor pending-review count must use inArray(videoSubmissions.status, [...])");
  const list = m[1];
  assert.match(list, /"received"/, "status set must include 'received'");
  assert.match(list, /"queued"/, "status set must include 'queued'");
  assert.match(list, /"transcoding"/, "status set must include 'transcoding'");
  assert.match(list, /"review_pending"/, "status set must include 'review_pending'");
  assert.doesNotMatch(list, /"ready"/, "status set must NOT include 'ready' — those are reviewed-ready, not pending");
  assert.doesNotMatch(list, /"reviewed"/, "status set must NOT include 'reviewed'");
  // Context type filter — only teach_back videos count toward the mentor queue.
  assert.match(
    src,
    /eq\(videoSubmissions\.contextType,\s*"teach_back"\)/,
    "mentor pending-review count must filter context_type = 'teach_back' per the brief",
  );
});

test("spec 127 — mentor variant joins through teachers → mentor_pairings (mentor scoped)", () => {
  const src = read(PAGE_PATH);
  // The mentor must join videoSubmissions → teachers (via submittedByUserId =
  // teachers.userId) → mentorPairings (mentor_id = current mentor row) so the
  // queue is scoped to mentees this mentor actually works with.
  assert.match(
    src,
    /eq\(teachers\.userId,\s*videoSubmissions\.submittedByUserId\)/,
    "mentor queue must join teachers.userId = videoSubmissions.submittedByUserId so we resolve the teacher who uploaded",
  );
  assert.match(
    src,
    /eq\(mentorPairings\.mentorId,\s*mentorId\)/,
    "mentor queue must filter mentorPairings.mentorId = <this mentor's id>",
  );
  // Active-pairing filter — paused / ended / complete pairings don't count.
  assert.match(
    src,
    /eq\(mentorPairings\.status,\s*"active"\)/,
    "mentor queue must filter mentorPairings.status = 'active' — paused/ended pairings don't owe the mentor any review work",
  );
});

test("spec 127 — mentor variant renders the four prototype labels", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /Active mentees/, "mentor variant must render 'Active mentees'");
  assert.match(src, /Pending video reviews/, "mentor variant must render 'Pending video reviews'");
  assert.match(src, /Scheduled meetings this week/, "mentor variant must render 'Scheduled meetings this week'");
  assert.match(src, /Q-progress forms due/, "mentor variant must render 'Q-progress forms due'");
});

test("spec 127 — observer variant scopes to observer_id with the three brief labels", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /Cycles I am leading \(active\)/, "observer variant must render 'Cycles I am leading (active)'");
  assert.match(src, /Pending observer forms/, "observer variant must render 'Pending observer forms'");
  assert.match(src, /Cycles awaiting sign-off/, "observer variant must render 'Cycles awaiting sign-off'");
  // The observer filter must hit observation_cycles.observer_id.
  assert.match(
    src,
    /eq\(observationCycles\.observerId,\s*userId\)/,
    "observer variant must filter observation_cycles.observer_id = session.user.id — counts are user-scoped",
  );
});

test("spec 127 — programme_admin + super_admin share base stats; super_admin adds three more", () => {
  const src = read(PAGE_PATH);
  // Programme-wide base stats (active pairings, cycles in flight, recent
  // uploads, pending observer forms).
  assert.match(src, /Active pairings/, "admin variants must render 'Active pairings'");
  assert.match(src, /Cycles in flight/, "admin variants must render 'Cycles in flight'");
  assert.match(src, /Recent uploads \(24h\)/, "admin variants must render 'Recent uploads (24h)'");
  // Super-admin-only stats.
  assert.match(src, /Total users/, "super_admin variant must add 'Total users'");
  assert.match(src, /Audit events \(24h\)/, "super_admin variant must add 'Audit events (24h)'");
  assert.match(src, /Storage used \(MB\)/, "super_admin variant must add 'Storage used (MB)'");
  // The super-admin add-ons are gated behind a role check.
  assert.match(
    src,
    /role === "super_admin"/,
    "super_admin extras must be conditionally added only for the super_admin role",
  );
});

test("spec 127 — super_admin storage uses SUM(files.size_bytes) proxy (documented deviation)", () => {
  const src = read(PAGE_PATH);
  // The proxy uses SQL SUM over files.sizeBytes — not a MinIO probe.
  assert.match(
    src,
    /SUM\(\$\{files\.sizeBytes\}\)/,
    "storageMb must be derived from SUM(files.size_bytes) — the brief allows this proxy when MinIO is inaccessible",
  );
  // Exclude soft-deleted rows — matches the MinIO tombstone semantics.
  assert.match(
    src,
    /isNull\(files\.deletedAt\)/,
    "storage proxy must exclude soft-deleted files via isNull(files.deletedAt)",
  );
});

test("spec 127 — page fires the dashboard.viewed audit per render", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/, "page must import recordAudit from @/lib/audit");
  assert.match(
    src,
    /action:\s*"dashboard\.viewed"/,
    "page must record a 'dashboard.viewed' audit event per the spec's audit hook",
  );
  // Role goes into the metadata so the audit log surface can group by role.
  assert.match(
    src,
    /metadata:\s*\{\s*role\s*\}/,
    "dashboard.viewed audit must carry metadata.role so ops can filter by which dashboard a user opened",
  );
  // The audit call is fire-and-forget (void) so a slow insert doesn't delay
  // the page render.
  assert.match(
    src,
    /void recordAudit\(/,
    "dashboard.viewed audit call must be void-prefixed — fire-and-forget per the harness pattern",
  );
});

test("spec 127 — FieldMap renders real schools, gated to admin roles, links to /repo/school/[id]", () => {
  const src = read(PAGE_PATH);
  // The schools query — db.select with active filter, capped, ordered by code.
  assert.match(
    src,
    /from\(schools\)/,
    "FieldMap query must select from the schools table",
  );
  assert.match(
    src,
    /eq\(schools\.active,\s*true\)/,
    "FieldMap query must filter schools.active = true",
  );
  // Visibility gate — only super_admin + programme_admin see the FieldMap.
  assert.match(
    src,
    /showFieldMap\s*=\s*role === "super_admin"\s*\|\|\s*role === "programme_admin"/,
    "FieldMap must be gated to super_admin + programme_admin only — teachers/observers/mentors don't get the field-ops view",
  );
  // Each dot deep-links to /repo/school/[id].
  assert.match(
    src,
    /\/repo\/school\/\$\{m\.id\}/,
    "FieldMap dots must link to /repo/school/<id> so admins can drill into a school",
  );
  // SVG <title> tooltip per dot — gives the school name on hover.
  assert.match(
    src,
    /<title>\{m\.name\}/,
    "FieldMap dots must carry an SVG <title> tooltip with the school name",
  );
});

test("spec 127 — TodayChecklist is data-driven, not hardcoded prototype strings", () => {
  const src = read(PAGE_PATH);
  // The three hardcoded prototype strings from the original page MUST be gone.
  assert.ok(
    !/Review pending video submissions/.test(src),
    "TodayChecklist must not still render the hardcoded 'Review pending video submissions' row from the prototype",
  );
  assert.ok(
    !/Confirm school visits this week/.test(src),
    "TodayChecklist must not still render the hardcoded 'Confirm school visits this week' row",
  );
  // The page must now derive todos from the chrome helpers.
  assert.match(
    src,
    /todos\.length === 0/,
    "TodayChecklist must handle the empty-todo case — proves the rows are computed, not literal",
  );
  // Each role must wire a per-role todo builder.
  for (const fn of ["getMentorTodos", "getAdminTodos", "getTeacherTodos", "getObserverTodos"]) {
    assert.match(
      src,
      new RegExp(`function ${fn}\\(`),
      `page must declare per-role todo builder ${fn}() so each variant has its own real-data todo list`,
    );
  }
});

test("spec 127 — no hardcoded literal stat values bleed back into the JSX", () => {
  const src = read(PAGE_PATH);
  // The prototype's hardcoded stat values (value="3", value="5", value="142",
  // value="284") must not appear in the production page. We grep on the JSX
  // attribute form to avoid false positives on time-window constants.
  const hardcodedAttr = src.match(/value=\{"\d+"\}|value="(\d+)"/g) ?? [];
  assert.deepEqual(
    hardcodedAttr,
    [],
    `dashboard page must not contain hardcoded stat values; found: ${hardcodedAttr.join(", ")}`,
  );
});

test("spec 127 — page does not contain TODO / FIXME / placeholder markers", () => {
  const src = read(PAGE_PATH);
  assert.ok(!/\bTODO\b/.test(src), `${PAGE_PATH} must not contain TODO markers`);
  assert.ok(!/\bFIXME\b/.test(src), `${PAGE_PATH} must not contain FIXME markers`);
  assert.ok(
    !/Lands in spec/.test(src),
    `${PAGE_PATH} must not contain 'Lands in spec' placeholder text`,
  );
});
