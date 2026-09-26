// Governance test for spec 101 — docker-compose env completeness (Tier A2).
// Asserts the deployment-blocker env vars are present in docker-compose.yml
// using the strict-fail `${VAR:?msg}` form, AND are documented in .env.example
// for fresh-operator discoverability.
//
// PARTLY INVERTED. Spec 101's mechanism — "a variable the deployment cannot
// work without must make compose REFUSE TO START rather than default to
// something that looks like it works" — is exactly right and is kept, applied
// to a wider set. What changed is the list.
//
// MEDIA_SIGN_SECRET is gone from every assertion here, because the thing it
// signed no longer exists. The hand-rolled media-token signer was deleted
// outright; see tests/governance/test_145_signed_url_subnet_binding.test.mjs
// for the full reasoning. The short version is that the secret was never set
// anywhere, so the signer silently fell back to a dev-only AUTH_SECRET that was
// committed to this repository, and the token answered "does this string
// verify" rather than "may this person watch this video". Demanding a
// strict-fail declaration for it would now force operators to invent a value
// that nothing reads. Playback is a session-authenticated route that re-runs
// assertCanAccessVideo on every request.
//
// Added in its place: the four Supabase/database variables, which really are
// deployment blockers — the stack has no local Postgres and no local object
// store any more, so an unset DATABASE_URL or SUPABASE_SECRET_KEY is not a
// degraded deployment, it is no deployment at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

/** `#`-comment-stripped view, so prose about a removed variable is not evidence of it. */
const code = (src) => src.replace(/(^|\s)#.*$/gm, "$1");

/** Every variable compose must refuse to start without. */
const REQUIRED = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ACME_EMAIL",
];

test("FR-001: WHATSAPP_APP_SECRET is passed to the app but optional; the route is what refuses without it", () => {
  // INVERTED. This required the ${VAR:?} strict-fail form, from when an unset
  // secret made the webhook accept unsigned POSTs. The route now fails closed
  // (503 whatsapp_not_configured for every request -- executed in
  // tests/behaviour/whatsapp-unconfigured.test.ts), so requiring the secret here
  // protected nothing and stopped the LMS starting before WhatsApp was set up.
  const yaml = readText("docker-compose.yml");
  assert.match(
    yaml,
    /WHATSAPP_APP_SECRET:\s*\$\{WHATSAPP_APP_SECRET:-\}/,
    "WHATSAPP_APP_SECRET must still reach the app container, as an optional value",
  );
  assert.match(
    readText("apps/web/src/app/api/webhooks/whatsapp/route.ts"),
    /if \(!process\.env\.WHATSAPP_APP_SECRET\) \{[\s\S]{0,120}?status: 503/,
    "the webhook must refuse every request while the secret is unset",
  );
});

test("FR-002: the Supabase + database variables use the strict-fail form", () => {
  const yaml = readText("docker-compose.yml");
  // Replaces the MEDIA_SIGN_SECRET assertion (see this file's header). These
  // four are the variables that took over its slot as "cannot deploy without".
  for (const key of [
    "DATABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
  ]) {
    assert.match(
      yaml,
      new RegExp(`${key}:\\s*\\$\\{${key}:\\?[^}]+\\}`),
      `${key} must use the \${VAR:?message} strict-fail form in docker-compose.yml`,
    );
  }
});

test("FR-002: MEDIA_SIGN_SECRET and AUTH_SECRET are declared nowhere", () => {
  const yaml = code(readText("docker-compose.yml"));
  const env = code(readText(".env.example"));
  for (const key of ["MEDIA_SIGN_SECRET", "AUTH_SECRET"]) {
    assert.ok(
      !new RegExp(`\\b${key}\\b`).test(yaml),
      `${key} must not appear in docker-compose.yml — the signer that read it was deleted`,
    );
    assert.ok(
      !new RegExp(`\\b${key}\\b`).test(env),
      `${key} must not appear in .env.example — asking an operator to set a secret ` +
        "that nothing reads teaches them the file is not to be trusted",
    );
  }
});

test("FR-003: docker-compose.yml declares ACME_EMAIL with strict-fail form", () => {
  const yaml = readText("docker-compose.yml");
  assert.match(
    yaml,
    /ACME_EMAIL:\s*\$\{ACME_EMAIL:\?[^}]+\}/,
    "ACME_EMAIL must use the ${VAR:?message} strict-fail form in docker-compose.yml",
  );
});

test("FR-004: strict-fail messages are descriptive (>= 20 chars) — operators must get a useful error", () => {
  const yaml = readText("docker-compose.yml");
  // Unchanged in substance — only the list is different. The property being
  // protected (compose's `:?` message is the ENTIRE diagnostic the operator
  // gets, so "unset" alone is useless) applies to every required variable, so
  // this now sweeps all six rather than the original three.
  for (const key of REQUIRED) {
    const re = new RegExp(`${key}:\\s*\\$\\{${key}:\\?([^}]+)\\}`);
    const m = yaml.match(re);
    assert.ok(m, `${key} strict-fail entry not found`);
    assert.ok(
      m[1].trim().length >= 20,
      `${key} strict-fail message must be descriptive (>=20 chars), got: "${m[1]}"`,
    );
  }
});

test("FR-005: .env.example contains WHATSAPP_APP_SECRET", () => {
  const env = readText(".env.example");
  assert.match(env, /^WHATSAPP_APP_SECRET=/m, ".env.example must declare WHATSAPP_APP_SECRET");
});

test("FR-006: .env.example documents every strict-fail variable", () => {
  const env = readText(".env.example");
  // Replaces "contains MEDIA_SIGN_SECRET". The discoverability property is the
  // one worth keeping: a variable that makes compose abort MUST be in the file
  // the operator copies, or the first deploy dies on an error about a name
  // they have never seen. DOMAIN is included because Caddy's certificate
  // depends on it even though compose defaults it to localhost.
  for (const key of [...REQUIRED, "DOMAIN"]) {
    assert.match(
      env,
      new RegExp(`^${key}=`, "m"),
      `.env.example must declare ${key}= on its own line`,
    );
  }
});

test("FR-007: .env.example contains ACME_EMAIL", () => {
  const env = readText(".env.example");
  assert.match(env, /^ACME_EMAIL=/m, ".env.example must declare ACME_EMAIL");
});

test("FR-009: WHATSAPP_APP_SECRET + the Supabase keys sit under the `app` service block", () => {
  const yaml = readText("docker-compose.yml");
  // app service starts at "^  app:" and ends at the next top-level service or section.
  const appBlockMatch = yaml.match(/^ {2}app:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|^volumes:|^networks:)/m);
  assert.ok(appBlockMatch, "could not isolate `app` service block in docker-compose.yml");
  const appBlock = appBlockMatch[1];
  // Placement, not just presence: a variable declared in the file but forwarded
  // to no container is how this repo previously shipped five documented knobs
  // that reached nothing. MEDIA_SIGN_SECRET has been swapped for the four
  // variables the web tier genuinely cannot serve a page without.
  assert.match(appBlock, /WHATSAPP_APP_SECRET:/, "WHATSAPP_APP_SECRET must live under the app service");
  for (const key of [
    "DATABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
  ]) {
    assert.match(appBlock, new RegExp(`${key}:`), `${key} must be forwarded to the app service`);
  }
});

test("FR-009: the worker gets the database + Supabase credentials too", () => {
  const yaml = readText("docker-compose.yml");
  const workerBlockMatch = yaml.match(
    /^ {2}worker:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|^volumes:|^networks:)/m,
  );
  assert.ok(workerBlockMatch, "could not isolate `worker` service block in docker-compose.yml");
  const workerBlock = workerBlockMatch[1];
  // The worker now claims jobs from a Postgres table (`FOR UPDATE SKIP LOCKED`)
  // instead of Redis, and writes HLS output straight to Supabase Storage. Both
  // of those are new hard dependencies for a container that used to need
  // neither, so they are pinned here.
  for (const key of ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    assert.match(workerBlock, new RegExp(`${key}:`), `${key} must be forwarded to the worker service`);
  }
  assert.match(
    workerBlock,
    /WORKER_CONCURRENCY:\s*\$\{WORKER_CONCURRENCY:-1\}/,
    "worker concurrency must default to 1: one ffmpeg at -preset veryfast already " +
      "saturates both vCPUs of the target instance, and a second starves the web tier",
  );
});

test("FR-009: ACME_EMAIL sits under the `caddy` service block", () => {
  const yaml = readText("docker-compose.yml");
  const caddyBlockMatch = yaml.match(/^ {2}caddy:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|^volumes:|^networks:)/m);
  assert.ok(caddyBlockMatch, "could not isolate `caddy` service block in docker-compose.yml");
  const caddyBlock = caddyBlockMatch[1];
  assert.match(caddyBlock, /ACME_EMAIL:/, "ACME_EMAIL must live under the caddy service");
});
