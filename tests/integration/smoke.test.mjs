// Integration smoke test — spec 111 (Workflow Run 8 Tier E1).
//
// This is the FIRST behavioural (non-grep) test in the repo. Every other test
// under `tests/governance/` asserts file contents; this one drives the
// running app via real HTTP `fetch()` calls and observes responses.
//
// Usage:
//   SMOKE_BASE_URL=http://localhost:3000 pnpm test:smoke
//
// Default base URL is http://localhost:3000. The suite is SKIPPED — not
// failed — if the app is unreachable. That way CI environments that do not
// boot the full Docker stack stay green: only operators who explicitly run
// `pnpm test:smoke` after `make up` will exercise these checks.
//
// Why skipped-on-unreachable instead of failed?
//   The governance tests run on every `pnpm test`. We do NOT want a green
//   `pnpm test` to depend on a live Postgres+Redis+MinIO+Next.js stack
//   being up. Smoke is opt-in via the `test:smoke` script.
//
// Endpoints covered (12 distinct fetches against the running app — the
// first 8 are the spec-111 originals; the last 4 were added in
// the spec-171 run-16 audit-closure docs refresh to cover the new
// admin surfaces and the password-reset entry point):
//   1.  GET  /api/health                       → 200, JSON shape with db/redis/minio/migrations
//   2.  GET  /login                            → 200, contains visible "Sign in" text
//   3.  GET  /api/auth/csrf                    → 200, csrfToken present
//   4.  POST /api/auth/callback/credentials    → 401 / redirect-with-error (bad credentials)
//   5.  GET  /dashboard (no auth)              → 302 → /login (middleware gate)
//   6.  GET  /api/health (re-check)            → migrations.ok must be true (boot ran migrations)
//   7.  POST /api/notifications/mark-read      → 401 (auth gate, spec 096)
//   8.  POST /api/webhooks/whatsapp (no sig)   → 401 (signature verification, spec 040)
//   9.  GET  /admin/quizzes (anon)             → 302 to /login OR 403 to /forbidden (spec 120 surface)
//   10. GET  /admin/transcode-jobs (anon)      → 302 to /login OR 403 to /forbidden (spec 162 surface)
//   11. GET  /admin/system-settings (anon)     → 302 to /login OR 403 to /forbidden (spec 124 surface)
//   12. GET  /login/forgot                     → 200 (public surface — gates SMTP-availability rendering)

import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// Module-level reachability flag. The `before` hook sets this once; each test
// short-circuits with `t.skip(...)` if the app is not up. We use a flag rather
// than top-level `await` so the file remains importable in non-running envs.
let reachable = false;
let probeError = null;

// Probe with a hard 2-second timeout. AbortController is the canonical way to
// cap a fetch in Node 18+ without pulling in any timeout shim.
async function probe() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(BASE + "/api/health", { signal: ctl.signal });
    return res.status === 200;
  } catch (err) {
    probeError = err;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

before(async () => {
  reachable = await probe();
});

function skipIfUnreachable(t) {
  if (!reachable) {
    t.skip(
      "app not reachable at " + BASE +
      (probeError ? " (" + (probeError.message ?? probeError) + ")" : "") +
      " — set SMOKE_BASE_URL or `make up` first",
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. /api/health — full shape check
// ---------------------------------------------------------------------------
test("smoke 1: GET /api/health returns 200 with the spec-110 JSON shape", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/api/health");
  assert.equal(res.status, 200, "health endpoint must respond 200");
  const body = await res.json();
  assert.equal(typeof body.ok, "boolean", "body.ok must be boolean");
  assert.ok(body.details, "body.details must exist");
  assert.equal(typeof body.details.db?.ok, "boolean", "details.db.ok must be boolean");
  assert.equal(typeof body.details.redis?.ok, "boolean", "details.redis.ok must be boolean");
  assert.equal(typeof body.details.minio?.ok, "boolean", "details.minio.ok must be boolean");
  assert.equal(typeof body.details.migrations?.ok, "boolean", "details.migrations.ok must be boolean");
});

// ---------------------------------------------------------------------------
// 2. /login — visible sign-in copy
// ---------------------------------------------------------------------------
test("smoke 2: GET /login renders the sign-in page", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/login");
  assert.equal(res.status, 200, "/login must respond 200");
  const html = await res.text();
  // Accept "Sign in" (English) or the localised Hindi/Ladakhi variant — the
  // login reskin (spec 034) ships English by default with i18n hooks.
  assert.ok(
    /Sign in|Sign In|sign in|लॉग/i.test(html),
    "/login HTML must contain a visible 'Sign in' (or localised equivalent) string",
  );
});

// ---------------------------------------------------------------------------
// 3. /api/auth/csrf — Auth.js anti-CSRF token
// ---------------------------------------------------------------------------
test("smoke 3: GET /api/auth/csrf returns a csrfToken", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/api/auth/csrf");
  assert.equal(res.status, 200, "/api/auth/csrf must respond 200");
  const body = await res.json();
  assert.equal(typeof body.csrfToken, "string", "csrfToken must be a string");
  assert.ok(body.csrfToken.length > 0, "csrfToken must be non-empty");
});

// ---------------------------------------------------------------------------
// 4. /api/auth/callback/credentials — bad credentials → 401 or redirect-with-error
// ---------------------------------------------------------------------------
test("smoke 4: POST /api/auth/callback/credentials rejects bad credentials", async (t) => {
  if (skipIfUnreachable(t)) return;
  // Auth.js requires the CSRF token to be present, so we ask for one first.
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams();
  form.set("csrfToken", csrfToken);
  form.set("email", "nobody@invalid.example");
  form.set("password", "wrong-password");
  form.set("callbackUrl", BASE + "/dashboard");
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  // Auth.js v5 default behaviour on credentials failure: 302 to /login with
  // ?error=CredentialsSignin. Older versions sometimes 401 directly. Accept
  // either to keep the test resilient to the upstream contract.
  if (res.status === 401) {
    return; // 401 is acceptable
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    assert.ok(
      /error=|signin|login/i.test(loc),
      "redirect after bad credentials must carry an error or land on /login, got: " + loc,
    );
    return;
  }
  assert.fail("bad credentials must yield 401 or redirect, got status " + res.status);
});

// ---------------------------------------------------------------------------
// 5. /dashboard (no auth) — middleware redirect to /login
// ---------------------------------------------------------------------------
test("smoke 5: GET /dashboard without a session redirects to /login", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/dashboard", { redirect: "manual" });
  assert.ok(
    res.status >= 300 && res.status < 400,
    "/dashboard must redirect when unauthenticated, got status " + res.status,
  );
  const loc = res.headers.get("location") ?? "";
  assert.ok(/\/login/.test(loc), "/dashboard redirect must point at /login, got: " + loc);
});

// ---------------------------------------------------------------------------
// 6. /api/health (second call) — migrations.ok must be true
// ---------------------------------------------------------------------------
test("smoke 6: GET /api/health reports migrations.ok=true (boot applied migrations)", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.details.migrations.ok,
    true,
    "migrations.ok must be true on a healthy stack — run `pnpm --filter @gml/db run migrate` if false",
  );
});

// ---------------------------------------------------------------------------
// 7. /api/notifications/mark-read (no session) — 401 auth gate
// ---------------------------------------------------------------------------
test("smoke 7: POST /api/notifications/mark-read without a session returns 401", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/api/notifications/mark-read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401, "mark-read must reject anonymous callers with 401");
});

// ---------------------------------------------------------------------------
// 8. /api/webhooks/whatsapp (no signature) — 401 signature failure
// ---------------------------------------------------------------------------
test("smoke 8: POST /api/webhooks/whatsapp without an HMAC signature returns 401", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
  });
  assert.equal(
    res.status,
    401,
    "unsigned WhatsApp webhook payload must be rejected with 401 (signature_failed)",
  );
});

// ---------------------------------------------------------------------------
// Helper: an anonymous GET against an admin-gated page must either redirect
// to /login (302) or hand back a 403 /forbidden body. Either is acceptable;
// the surface MUST NOT 200 with content. Added in spec 171 to cover the
// post-audit-closure admin surfaces.
// ---------------------------------------------------------------------------
function assertAuthGated(res, path) {
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    assert.ok(
      /\/login|\/forbidden/.test(loc),
      `${path} redirect must point at /login or /forbidden, got: ${loc}`,
    );
    return;
  }
  if (res.status === 403) return; // also acceptable
  assert.fail(
    `${path} (anon) must redirect (302) or 403; got status ${res.status}`,
  );
}

// ---------------------------------------------------------------------------
// 9. /admin/quizzes (anon) — must be auth-gated (spec 120 + 171)
// ---------------------------------------------------------------------------
test("smoke 9: GET /admin/quizzes (anon) redirects to /login or 403s", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/admin/quizzes", { redirect: "manual" });
  assertAuthGated(res, "/admin/quizzes");
});

// ---------------------------------------------------------------------------
// 10. /admin/transcode-jobs (anon) — must be auth-gated (spec 162 + 171)
// ---------------------------------------------------------------------------
test("smoke 10: GET /admin/transcode-jobs (anon) redirects to /login or 403s", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/admin/transcode-jobs", { redirect: "manual" });
  assertAuthGated(res, "/admin/transcode-jobs");
});

// ---------------------------------------------------------------------------
// 11. /admin/system-settings (anon) — must be auth-gated (spec 124 + 171)
// ---------------------------------------------------------------------------
test("smoke 11: GET /admin/system-settings (anon) redirects to /login or 403s", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/admin/system-settings", { redirect: "manual" });
  assertAuthGated(res, "/admin/system-settings");
});

// ---------------------------------------------------------------------------
// 12. /login/forgot — public surface, must render 200 (spec 161 + 171)
// ---------------------------------------------------------------------------
test("smoke 12: GET /login/forgot returns 200 (public surface)", async (t) => {
  if (skipIfUnreachable(t)) return;
  const res = await fetch(BASE + "/login/forgot");
  assert.equal(
    res.status,
    200,
    "/login/forgot must be reachable without a session — it's the password-reset entry point",
  );
  // The page either renders the reset form (SMTP configured) or the
  // "feature unavailable" banner (no SMTP). Either is fine; pin presence
  // of the page chrome by looking for the "password" word somewhere in
  // the HTML — both branches mention it.
  const html = await res.text();
  assert.ok(
    /password|reset|forgot/i.test(html),
    "/login/forgot HTML must contain the words 'password' / 'reset' / 'forgot' (either the form copy OR the unavailable-banner copy)",
  );
});
