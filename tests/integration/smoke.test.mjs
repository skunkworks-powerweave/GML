// Post-deploy smoke check. Drives a RUNNING deployment over real HTTP.
//
// ── WHAT CHANGED, AND WHY ────────────────────────────────────────────────────
//
// This suite used to SKIP itself when the app was unreachable, and CI ran it
// with `|| true` on top of that. `node --test` exits 0 when everything skips,
// so it was structurally incapable of failing — it reported green whether the
// deployment worked or not. That is the same failure the governance suite has:
// 1500 green assertions that cannot observe a runtime behaviour.
//
// It now FAILS when it cannot reach the target, and it is run by
// scripts/deploy.sh against the deployment that was just made, where a full
// stack genuinely exists. CI's behavioural coverage moved to
// `pnpm test:behaviour`, which runs against a real Postgres service container
// and does not need a booted application.
//
// Usage:
//   SMOKE_BASE_URL=https://lms.example.org pnpm test:smoke
//
// The assertions below were also substantially wrong. They tested Auth.js
// endpoints (/api/auth/csrf, /api/auth/callback/credentials) that no longer
// exist, and a /api/health response shape carrying `redis` and `minio` keys
// that were removed with the services.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/** fetch with a bounded timeout — a hung probe is a failed probe. */
async function get(path, init = {}) {
  return fetch(`${BASE}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
}

test("the deployment is reachable", async () => {
  // Deliberately the first test and deliberately fatal. Everything below is
  // meaningless if this fails, and a suite that quietly skips instead is how
  // this file spent its entire life being green without testing anything.
  let res;
  try {
    res = await get("/api/health");
  } catch (err) {
    assert.fail(
      `could not reach ${BASE} — ${String(err)}\n` +
        `Set SMOKE_BASE_URL to the deployment you want to check.`,
    );
  }
  assert.ok(res.status > 0);
});

test("/api/health reports the real state and the real shape", async () => {
  const res = await get("/api/health");
  const body = await res.json();

  // The status code must MATCH the body. This endpoint used to return 200 with
  // `ok:false`, so both the Docker healthcheck and the deploy script — which
  // read only the status code — called a stack with no schema "healthy".
  assert.equal(
    res.status,
    body.ok ? 200 : 503,
    `status ${res.status} contradicts ok=${body.ok}`,
  );

  for (const key of ["ok", "app", "db", "storage", "migrations"]) {
    assert.ok(key in body, `/api/health must report '${key}'`);
  }
  for (const gone of ["redis", "minio"]) {
    assert.ok(
      !(gone in body),
      `/api/health must not report '${gone}' — the service is gone, and a probe ` +
        `for it would pin the endpoint at 503 forever`,
    );
  }

  assert.equal(body.ok, true, `deployment is not healthy: ${JSON.stringify(body)}`);
  assert.equal(
    body.migrationsApplied,
    body.migrationsExpected,
    "migrations are not fully applied",
  );
});

test("/api/health does not leak driver detail to anonymous callers", async () => {
  const body = await (await get("/api/health")).json();
  assert.ok(
    !("details" in body),
    "raw driver messages carry internal hostnames, ports and auth-failure text, " +
      "and this endpoint is public. Set HEALTH_DEBUG=1 deliberately if you need them.",
  );
});

test("/login renders", async () => {
  const res = await get("/login");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /sign in/i, "the login page must actually render its form");
});

test("an unauthenticated page request redirects to /login, not 403", async () => {
  // The 401-vs-403 split: an anonymous visitor needs to be told to sign in,
  // not that they lack a role. Collapsing the two sent people to ask an
  // administrator for permission they already had.
  const res = await get("/dashboard");
  assert.equal(res.status, 307, `expected a redirect, got ${res.status}`);
  const location = res.headers.get("location") ?? "";
  assert.match(location, /\/login/, "must redirect to /login");
  assert.match(
    location,
    /from=/,
    "must carry ?from= so the login page can return the user to where they were going",
  );
});

test("an anonymous admin visit redirects rather than 403ing", async () => {
  const res = await get("/admin/users");
  assert.equal(
    res.status,
    307,
    "the session check must run BEFORE the role gate — otherwise an anonymous " +
      "visit to /admin/* yields a 403, hiding the fact that the user simply " +
      "needs to sign in",
  );
});

test("API routes answer 401, not a redirect", async () => {
  // A fetch caller following a 307 to /login gets an HTML page where it
  // expected JSON. Route handlers must answer with a status you can branch on.
  for (const path of [
    "/api/notifications/unread-count",
    "/api/user-prefs",
    "/api/quickfind?q=a",
  ]) {
    const res = await get(path);
    assert.ok(
      res.status === 401 || res.status === 307,
      `${path} returned ${res.status}; expected 401 (or a redirect at the proxy)`,
    );
  }
});

test("the WhatsApp webhook refuses an unsigned POST", async () => {
  // This is the primary, internet-facing ingest path. It used to accept
  // unsigned POSTs from anyone when WHATSAPP_APP_SECRET was unset — and the
  // variable was absent from .env.example, so that was the default everywhere.
  const res = await get("/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: [] }),
  });
  assert.equal(
    res.status,
    401,
    "an unsigned webhook POST must be refused — anything else lets a stranger " +
      "inject video submissions and make the worker fetch arbitrary URLs",
  );
});

test("the deleted auth endpoints are actually gone", async () => {
  for (const path of [
    "/api/auth/csrf",
    "/api/auth/session",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/uploads/tus",
  ]) {
    const res = await get(path);
    assert.ok(
      res.status === 404 || res.status === 405,
      `${path} still answers ${res.status} — it should not exist`,
    );
  }
});

test("security headers are present on an HTML response", async () => {
  const res = await get("/login");
  const h = res.headers;

  // Only meaningful behind Caddy; a direct hit on the app container has no
  // proxy to add them. Skipped rather than failed in that case, with a message
  // that says which it was.
  if (!h.get("content-security-policy")) {
    assert.ok(
      BASE.includes("localhost") || BASE.includes("127.0.0.1"),
      "no CSP on a non-local target — Caddy is not adding its security headers",
    );
    return;
  }

  const csp = h.get("content-security-policy");
  assert.match(csp, /script-src 'self'/, "script-src must not be widened");
  assert.ok(
    !/script-src[^;]*unsafe-(inline|eval)/.test(csp),
    "script-src must grant neither unsafe-inline nor unsafe-eval — the Supabase " +
      "auth cookies are not httpOnly, so an XSS on this origin yields the token",
  );
  assert.match(h.get("x-content-type-options") ?? "", /nosniff/);
  assert.ok(h.get("permissions-policy"), "Permissions-Policy must be set");
});
