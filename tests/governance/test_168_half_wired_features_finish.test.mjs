// Governance test for spec 168 — Half-wired features finish (Workflow Run 16
// post-audit hardening).
//
// Four half-wired features get finished:
//
//   (A) system_settings consumers — programmeName/academicYear on /admin,
//       videoDefaultQuality on /videos UploadModal, notificationsEnabled
//       on chrome bell badge.
//   (B) /login/forgot SMTP-aware UX — server component that reads SMTP_HOST
//       at render time and surfaces a saffron banner when unset.
//   (C) /admin/transcode-jobs Redis-down banner — explicit role="alert"
//       banner above the historical table.
//   (D) /repo/students name search with audit dedup — ilike(learners.name)
//       protected by recordAuditDedup so the audit log doesn't flood.
//
// Plus the five spec-kit files under specs/168-half-wired-features-finish/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SPEC_DIR = "specs/168-half-wired-features-finish";
const SYSTEM_SETTINGS_LIB = "apps/web/src/lib/system-settings.ts";
const AUDIT_LIB = "apps/web/src/lib/audit.ts";
const CHROME_COUNTS = "apps/web/src/lib/chrome-counts.ts";
const UPLOAD_MODAL = "apps/web/src/components/video/UploadModal.tsx";
const VIDEOS_PAGE = "apps/web/src/app/(authenticated)/videos/page.tsx";
const ADMIN_HOME = "apps/web/src/app/(authenticated)/admin/page.tsx";
const FORGOT_PAGE = "apps/web/src/app/login/forgot/page.tsx";
const FORGOT_FORM = "apps/web/src/app/login/forgot/ForgotPasswordForm.tsx";
const TRANSCODE_JOBS = "apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx";
const STUDENTS_PAGE = "apps/web/src/app/(authenticated)/repo/students/page.tsx";
const SPEC_158_TEST = "tests/governance/test_158_repo_search_bars.test.mjs";

// ---------- Spec-kit + plan.md contract ----------

test("spec 168 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the half-wired-features-finish spec`,
    );
  }
});

test("spec 168 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // All seven edited / created files must be named so the surface area
  // is discoverable from the plan alone.
  for (const file of [
    "system-settings.ts",
    "audit.ts",
    "UploadModal.tsx",
    "chrome-counts.ts",
    "admin/page.tsx",
    "forgot/page.tsx",
    "transcode-jobs/page.tsx",
    "repo/students/page.tsx",
    "ForgotPasswordForm.tsx",
  ]) {
    assert.match(
      src,
      new RegExp(file.replace(/[/.]/g, "\\$&")),
      `plan.md must call out the ${file} edit so the surface is discoverable`,
    );
  }
});

// ---------- (A) system_settings consumers ----------

test("spec 168 — apps/web/src/lib/system-settings.ts exists and exports a cache()'d getSystemSettings", () => {
  assert.ok(
    existsSync(resolve(root, SYSTEM_SETTINGS_LIB)),
    `${SYSTEM_SETTINGS_LIB} must exist — this is the React.cache()'d singleton row loader for spec 168 consumers`,
  );
  const src = read(SYSTEM_SETTINGS_LIB);
  assert.match(
    src,
    /import\s+\{[^}]*\bcache\b[^}]*\}\s+from\s+"react"/,
    `${SYSTEM_SETTINGS_LIB} must import \`cache\` from React so the loader memoizes per-render`,
  );
  assert.match(
    src,
    /export\s+const\s+getSystemSettings\s*=\s*cache\s*\(/,
    `${SYSTEM_SETTINGS_LIB} must export getSystemSettings wrapped in cache(...) — the cache memoizes the singleton row across all consumers in one render`,
  );
  assert.match(
    src,
    /SYSTEM_SETTINGS_ID/,
    `${SYSTEM_SETTINGS_LIB} must SELECT by SYSTEM_SETTINGS_ID — the singleton sentinel pinned by the system_settings_singleton CHECK constraint`,
  );
  assert.match(
    src,
    /\.limit\(\s*1\s*\)/,
    `${SYSTEM_SETTINGS_LIB} must \`.limit(1)\` on the SELECT — defensive against a row count > 1 (should be impossible given the CHECK constraint, but the limit keeps the planner happy)`,
  );
  assert.match(
    src,
    /"server-only"/,
    `${SYSTEM_SETTINGS_LIB} must import "server-only" so a client component can't accidentally pull the loader into the browser bundle`,
  );
});

test("spec 168 — UploadModal accepts videoDefaultQuality and renders an explainer", () => {
  const src = read(UPLOAD_MODAL);
  assert.match(
    src,
    /videoDefaultQuality\?\s*:\s*string\s*\|\s*null/,
    `${UPLOAD_MODAL} must declare \`videoDefaultQuality?: string | null\` on its props so the videos page can pass the system_settings value`,
  );
  assert.match(
    src,
    /data-testid="upload-quality-explainer"/,
    `${UPLOAD_MODAL} must render a data-testid="upload-quality-explainer" so the governance test + future e2e tests can anchor on the wire-through`,
  );
  assert.match(
    src,
    /\{videoDefaultQuality\s*\?\?\s*"480p"\}/,
    `${UPLOAD_MODAL} must default to "480p" when videoDefaultQuality is null so a pre-bootstrap deployment still renders sensible copy`,
  );
});

test("spec 168 — videos page reads system settings and passes videoDefaultQuality to UploadModal", () => {
  const src = read(VIDEOS_PAGE);
  assert.match(
    src,
    /from\s+"@\/lib\/system-settings"/,
    `${VIDEOS_PAGE} must import from "@/lib/system-settings" so it can fetch the singleton row`,
  );
  assert.match(
    src,
    /videoDefaultQuality=\{[^}]*videoDefaultQuality[^}]*\}/,
    `${VIDEOS_PAGE} must pass videoDefaultQuality to <UploadModal /> — the wire-through is the whole point of spec 168(A)`,
  );
});

test("spec 168 — chrome-counts filters loadUnreadNotifications by system_settings.notificationsEnabled", () => {
  const src = read(CHROME_COUNTS);
  assert.match(
    src,
    /from\s+"\.\/system-settings"/,
    `${CHROME_COUNTS} must import from "./system-settings" so the loader can consult notificationsEnabled`,
  );
  assert.match(
    src,
    /getSystemSettings\s*\(/,
    `${CHROME_COUNTS} must call getSystemSettings() inside loadUnreadNotifications so the bell count is filtered`,
  );
  assert.match(
    src,
    /inArray\(\s*notifications\.kind\s*,/,
    `${CHROME_COUNTS} must filter via inArray(notifications.kind, ...) so the SQL WHERE narrows to enabled kinds — a JS-side filter would still count disabled rows`,
  );
});

test("spec 168 — admin home surfaces programmeName + academicYear from system_settings", () => {
  const src = read(ADMIN_HOME);
  assert.match(
    src,
    /from\s+"@\/lib\/system-settings"/,
    `${ADMIN_HOME} must import getSystemSettings so the header reads from the singleton row, not a hardcoded literal`,
  );
  assert.match(
    src,
    /data-testid="admin-programme-name"/,
    `${ADMIN_HOME} must render data-testid="admin-programme-name" so the test can pin the wire-through`,
  );
  assert.match(
    src,
    /programmeName/,
    `${ADMIN_HOME} must reference programmeName — the field from system_settings replacing the hardcoded "Goldenmile RTT"`,
  );
  assert.match(
    src,
    /academicYear/,
    `${ADMIN_HOME} must reference academicYear so the period context is also surfaced (not just the programme name)`,
  );
});

// ---------- (B) /login/forgot SMTP-aware UX ----------

test("spec 168 — /login/forgot is a server component reading SMTP_HOST", () => {
  const src = read(FORGOT_PAGE);
  // Server component contract: no "use client" directive at the top.
  assert.ok(
    !/^\s*"use client"/m.test(src),
    `${FORGOT_PAGE} must NOT declare "use client" — the server component reads SMTP_HOST at render time; an attacker reading the bundled JS must not be able to enumerate SMTP_HOST state`,
  );
  assert.match(
    src,
    /process\.env\.SMTP_HOST/,
    `${FORGOT_PAGE} must read process.env.SMTP_HOST at render time so the page can decide whether to surface the banner or the form`,
  );
  assert.match(
    src,
    /data-testid="forgot-password-smtp-unavailable"/,
    `${FORGOT_PAGE} must render the data-testid="forgot-password-smtp-unavailable" banner when SMTP is unset`,
  );
  assert.match(
    src,
    /Password reset is unavailable on this deployment/,
    `${FORGOT_PAGE} must surface the literal "Password reset is unavailable on this deployment" copy so the user gets a clear, actionable signal`,
  );
});

test("spec 168 — ForgotPasswordForm.tsx exists and declares 'use client'", () => {
  assert.ok(
    existsSync(resolve(root, FORGOT_FORM)),
    `${FORGOT_FORM} must exist — the client island carrying the form state, fetch call, and success view (extracted from the original spec-161 page)`,
  );
  const src = read(FORGOT_FORM);
  assert.match(
    src,
    /^\s*"use client"/m,
    `${FORGOT_FORM} must declare "use client" — the form uses useState + fetch which only work on the client`,
  );
  assert.match(
    src,
    /export\s+function\s+ForgotPasswordForm/,
    `${FORGOT_FORM} must export ForgotPasswordForm so the server-component shell can render it`,
  );
  // The no-enumeration contract still holds — the fetch call lands on
  // /api/auth/forgot-password regardless of SMTP_HOST state.
  assert.match(
    src,
    /\/api\/auth\/forgot-password/,
    `${FORGOT_FORM} must POST to /api/auth/forgot-password so the existing spec-161 no-enumeration contract is preserved`,
  );
});

// ---------- (C) /admin/transcode-jobs Redis-down banner ----------

test("spec 168 — transcode-jobs page declares redisUnavailable and renders a banner", () => {
  const src = read(TRANSCODE_JOBS);
  assert.match(
    src,
    /redisUnavailable\s*=\s*depth\s*===\s*null/,
    `${TRANSCODE_JOBS} must declare \`const redisUnavailable = depth === null\` so the JSX branch reads naturally`,
  );
  assert.match(
    src,
    /data-testid="dlq-redis-down-banner"/,
    `${TRANSCODE_JOBS} must render a data-testid="dlq-redis-down-banner" so the test + future e2e can verify the failure surface`,
  );
  assert.match(
    src,
    /Live queue depth unavailable/,
    `${TRANSCODE_JOBS} must surface the literal "Live queue depth unavailable" phrase — the banner's whole point is to make this obvious to a triaging operator`,
  );
  assert.match(
    src,
    /historical job table below is still accurate/,
    `${TRANSCODE_JOBS} must point the operator at the historical table — without that nudge an operator might assume the whole page is broken and reload uselessly`,
  );
  assert.match(
    src,
    /role="alert"/,
    `${TRANSCODE_JOBS} banner must use role="alert" so screen readers announce it on page load — a blind operator triaging an incident needs the live-depth-stale signal up-front`,
  );
});

// ---------- (D) /repo/students name search with audit dedup ----------

test("spec 168 — recordAuditDedup helper lives in lib/audit.ts", () => {
  const src = read(AUDIT_LIB);
  assert.match(
    src,
    /export\s+(async\s+)?function\s+recordAuditDedup/,
    `${AUDIT_LIB} must export a recordAuditDedup function — the helper that closes the SM-9 audit-flood risk on /repo/students`,
  );
  assert.match(
    src,
    /dedupKey/,
    `${AUDIT_LIB} recordAuditDedup must accept a dedupKey argument — the stable identifier that collapses duplicate events`,
  );
  assert.match(
    src,
    /ttlSeconds/,
    `${AUDIT_LIB} recordAuditDedup must accept a ttlSeconds argument — the dedup window`,
  );
  assert.match(
    src,
    /__dedupKey/,
    `${AUDIT_LIB} recordAuditDedup must stamp the dedupKey into metadata.__dedupKey — the reserved field name avoids collisions with the caller's own metadata keys`,
  );
  // Two-step shape: SELECT existing, conditional INSERT. The atomic
  // INSERT ... WHERE NOT EXISTS form would also pass this test, but the
  // pattern we ship is the simpler race-tolerant one.
  assert.match(
    src,
    /db\s*\.\s*select/,
    `${AUDIT_LIB} recordAuditDedup must SELECT the audit_log to check for an existing match before inserting — the dedup check`,
  );
  assert.match(
    src,
    /->>\s*'__dedupKey'/,
    `${AUDIT_LIB} recordAuditDedup must filter the dedup SELECT by the jsonb \`->> '__dedupKey'\` accessor — the canonical Postgres way to read a string field from a jsonb column`,
  );
});

test("spec 168 — /repo/students adds q= search with ilike on learners.name", () => {
  const src = read(STUDENTS_PAGE);
  assert.match(
    src,
    /q\?\s*:\s*string/,
    `${STUDENTS_PAGE} must declare q?: string on its SearchParams so ?q= typechecks`,
  );
  assert.match(
    src,
    /ilike\(\s*learners\.name\s*,/,
    `${STUDENTS_PAGE} must call ilike(learners.name, ...) so the search narrows on the canonical learner name column`,
  );
  assert.match(
    src,
    /function\s+escapeIlike/,
    `${STUDENTS_PAGE} must declare an escapeIlike helper so ILIKE wildcards %, _, \\ in user input don't act as pattern characters`,
  );
  assert.match(
    src,
    /SEARCH_Q_MAX\s*=\s*200/,
    `${STUDENTS_PAGE} must cap the search input at SEARCH_Q_MAX = 200 chars — same cap as spec 158 so the URL doesn't bloat and the planner isn't stressed`,
  );
  assert.match(
    src,
    /type="search"\s+name="q"/,
    `${STUDENTS_PAGE} must render an <input type="search" name="q"> form control — native HTML GET form, URL is the source of truth`,
  );
});

test("spec 168 — /repo/students calls recordAuditDedup with learners.search action", () => {
  const src = read(STUDENTS_PAGE);
  assert.match(
    src,
    /recordAuditDedup\s*\(/,
    `${STUDENTS_PAGE} must call recordAuditDedup — the dedup helper is what makes the search safe to add to an SM-9 surface`,
  );
  assert.match(
    src,
    /action:\s*"learners\.search"/,
    `${STUDENTS_PAGE} must use action: "learners.search" so the dedup key is per-event-class — collapsing across action values would be wrong`,
  );
  assert.match(
    src,
    /ttlSeconds:\s*3600/,
    `${STUDENTS_PAGE} must use ttlSeconds: 3600 — one row per (user × query × hour) is the spec-168 contract`,
  );
  assert.match(
    src,
    /dedupKey:\s*`q=\$\{[^}]+\}\|user=\$\{[^}]+\}`/,
    `${STUDENTS_PAGE} must construct the dedupKey as \`q=\${qFilter}|user=\${userId}\` — both axes (query + user) must be in the key or different users would silently dedup each other's searches`,
  );
});

// ---------- Cross-cutting hygiene ----------

test("spec 168 — no new dependencies introduced", () => {
  const pkg = read("apps/web/package.json");
  // The dedup helper is hand-rolled drizzle SELECT + INSERT; no need for
  // node-cache or lru-cache or a separate Redis-backed dedup lib.
  assert.ok(
    !/"node-cache"/.test(pkg),
    "apps/web must not depend on node-cache — recordAuditDedup uses the audit_log row itself as the source of truth, not an in-memory cache",
  );
  assert.ok(
    !/"lru-cache"/.test(pkg),
    "apps/web must not depend on lru-cache — same reason; the audit log is durable, an LRU cache is not",
  );
  // The /login/forgot SMTP check is `process.env.SMTP_HOST` truthy. No
  // need for a connect-and-tls probe — and certainly not for a heavyweight
  // SMTP client just to detect "is the env var set".
  assert.ok(
    !/"smtp-connection"/.test(pkg),
    "apps/web must not depend on smtp-connection — the env var truthy check is the right tradeoff between accuracy and DoS surface",
  );
});

test("spec 168 — spec 158 governance test is loosened, not deleted", () => {
  // The previous assertion pinned /repo/students as excluded from the
  // search round. Spec 168 loosens it to "search OK if dedup is wired".
  // The assertion must still EXIST (otherwise a future contributor who
  // removes the dedup wouldn't get caught), but the body must reference
  // both `ilike(learners.name` and `recordAuditDedup` as the loosened
  // contract.
  const src = read(SPEC_158_TEST);
  assert.match(
    src,
    /\/repo\/students/,
    `${SPEC_158_TEST} must still reference /repo/students — the assertion stays, only the body is loosened`,
  );
  assert.match(
    src,
    /recordAuditDedup/,
    `${SPEC_158_TEST} must reference recordAuditDedup in the loosened assertion — the new contract is "ilike OK iff dedup also called"`,
  );
  assert.match(
    src,
    /ilike\\?\(\\?\s*learners\\?\.name|ilike\\\(\\\\s\*learners\\\.name/,
    `${SPEC_158_TEST} must still anchor on the ilike(learners.name pattern — the dedup check is conditional on the ilike being present`,
  );
});

test("spec 168 — no TODO / FIXME markers leaked into shipped source", () => {
  for (const path of [
    SYSTEM_SETTINGS_LIB,
    AUDIT_LIB,
    UPLOAD_MODAL,
    CHROME_COUNTS,
    ADMIN_HOME,
    FORGOT_PAGE,
    FORGOT_FORM,
    TRANSCODE_JOBS,
    STUDENTS_PAGE,
  ]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 168 — every edited / created file carries an inline Spec 168 reference", () => {
  // A self-documenting cleanup contract — a future reader auditing any of
  // the touched files knows where the wire-through came from.
  for (const path of [
    SYSTEM_SETTINGS_LIB,
    AUDIT_LIB,
    UPLOAD_MODAL,
    CHROME_COUNTS,
    ADMIN_HOME,
    FORGOT_PAGE,
    FORGOT_FORM,
    TRANSCODE_JOBS,
    STUDENTS_PAGE,
  ]) {
    const src = read(path);
    assert.match(
      src,
      /Spec 168/,
      `${path} must carry an inline "Spec 168" reference so the wire-through is self-documenting`,
    );
  }
});
