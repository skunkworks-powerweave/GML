// Governance test for spec 170 — Redis singleton and error-page variants
// (Workflow Run 16 post-audit hardening).
//
// Pins:
//   1. apps/web/src/lib/redis.ts exists and exports the singleton +
//      pingRedis. Defaults match the worker's queues.ts shape.
//   2. apps/web/src/lib/rate-limit.ts no longer constructs its own
//      ioredis client; uses getRedis() from ./redis.
//   3. apps/web/src/lib/health.ts pingRedis delegates to ./redis's
//      pingRedis (no per-probe `new Redis` construction).
//   4. apps/web/src/app/forbidden/page.tsx is a Server Component
//      reading searchParams.reason and rendering four distinct
//      copy variants. The locked branch reads session.user.locked_until.
//   5. apps/web/src/auth.ts declares AccountLockedError extending
//      CredentialsSignin with code = "account_locked", and the
//      locked-account branch THROWS this instead of returning null.
//   6. apps/web/src/app/login/actions.ts catches account_locked
//      code and redirects to /forbidden?reason=locked.
//   7. All five spec-kit files exist under specs/170-*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const REDIS_PATH = "apps/web/src/lib/redis.ts";
const RATE_LIMIT_PATH = "apps/web/src/lib/rate-limit.ts";
const HEALTH_PATH = "apps/web/src/lib/health.ts";
const FORBIDDEN_PATH = "apps/web/src/app/forbidden/page.tsx";
const AUTH_PATH = "apps/web/src/auth.ts";
const LOGIN_ACTIONS_PATH = "apps/web/src/app/login/actions.ts";
const SPEC_DIR = "specs/170-redis-singleton-and-error-pages";

// ---------- Spec-kit + plan.md contract ----------

test("spec 170 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the redis-singleton-and-error-pages spec`,
    );
  }
});

test("spec 170 — plan.md follows the CREATED/EDITED/MIGRATED contract and names every surface", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The six touched files must be named in plan.md so a reader auditing
  // the contract knows where the surface area actually lives.
  for (const file of [
    "redis.ts",
    "rate-limit.ts",
    "health.ts",
    "forbidden",
    "auth.ts",
    "actions.ts",
  ]) {
    assert.match(
      src,
      new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- (1) Redis singleton ----------

test("spec 170 — apps/web/src/lib/redis.ts exists and exports getRedis + pingRedis", () => {
  assert.ok(existsSync(resolve(root, REDIS_PATH)), `${REDIS_PATH} must exist`);
  const src = read(REDIS_PATH);
  assert.match(
    src,
    /export\s+function\s+getRedis\s*\(\s*\)\s*:\s*IORedis/,
    "redis.ts must export `function getRedis(): IORedis` so callers have a typed factory",
  );
  assert.match(
    src,
    /export\s+async\s+function\s+pingRedis\s*\(\s*\)/,
    "redis.ts must export `async function pingRedis()` for the /api/health surface",
  );
});

test("spec 170 — redis.ts singleton uses module-scope cache and worker-aligned defaults", () => {
  const src = read(REDIS_PATH);
  // Module-scope cache variable - the singleton pattern. We pin the
  // shape `let _client: IORedis | null = null` so a future contributor
  // can't accidentally turn this into per-call construction.
  assert.match(
    src,
    /let\s+_client\s*:\s*IORedis\s*\|\s*null\s*=\s*null/,
    "redis.ts must declare `let _client: IORedis | null = null` at module scope so the singleton pattern is explicit",
  );
  // The three defaults that match queues.ts. Each pinned individually
  // so a partial drift (someone flips lazyConnect to false but leaves
  // maxRetries) hits a specific test failure.
  assert.match(
    src,
    /maxRetriesPerRequest\s*:\s*null/,
    "redis.ts singleton must set `maxRetriesPerRequest: null` matching the worker's queues.ts (caller-managed timeouts)",
  );
  assert.match(
    src,
    /enableReadyCheck\s*:\s*false/,
    "redis.ts singleton must set `enableReadyCheck: false` matching the worker's queues.ts",
  );
  assert.match(
    src,
    /lazyConnect\s*:\s*true/,
    "redis.ts singleton must set `lazyConnect: true` so `next build` doesn't fail when redis isn't running at build time",
  );
});

test("spec 170 — redis.ts pingRedis is a safe-never-throws probe", () => {
  const src = read(REDIS_PATH);
  // The probe must wrap getRedis().ping() in try/catch so the health
  // endpoint always gets a JSON shape back, never an unhandled throw.
  assert.match(
    src,
    /try\s*\{[\s\S]{0,200}\.ping\(\)/,
    "redis.ts pingRedis must wrap the `.ping()` call in try{} so it never throws into the health endpoint",
  );
  assert.match(
    src,
    /\{\s*ok\s*:\s*false[\s\S]{0,200}error/,
    "redis.ts pingRedis must return `{ ok: false, error: ... }` on the catch path so the caller can render a structured failure",
  );
  // The 200-char slice — defensive against a verbose ioredis stack
  // trace blowing up the /api/health response body.
  assert.match(
    src,
    /\.slice\(\s*0\s*,\s*200\s*\)/,
    "redis.ts pingRedis must `.slice(0, 200)` the error string so a verbose ioredis stack can't blow up the health response body",
  );
});

// ---------- (2) rate-limit.ts uses the singleton ----------

// Helper: strip /* … */ block comments and // line comments before
// running grep-style absence-pinning so a documentary mention in a
// comment doesn't false-positive the "no remaining direct construction"
// asserts below.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

test("spec 170 — rate-limit.ts no longer constructs its own ioredis client", () => {
  const src = stripComments(read(RATE_LIMIT_PATH));
  // The old shape was `_client = new Redis(url, { ... })` inside a
  // module-scope `client()` factory. Both must be gone — but a
  // documentary mention in a JSDoc / comment (explaining the singleton
  // refactor) is fine, so we strip comments before grepping.
  assert.ok(
    !/new\s+Redis\s*\(/.test(src),
    "rate-limit.ts must not contain a `new Redis(...)` construction in executable code — the singleton in ./redis owns the client now (comments mentioning the old shape are OK)",
  );
  assert.ok(
    !/_client\s*:\s*Redis\s*\|\s*null/.test(src),
    "rate-limit.ts must not carry its own `_client: Redis | null` module-scope cache (lives in ./redis now)",
  );
});

test("spec 170 — rate-limit.ts imports getRedis from ./redis and uses it", () => {
  const src = read(RATE_LIMIT_PATH);
  assert.match(
    src,
    /import\s*\{\s*getRedis\s*\}\s*from\s*["']\.\/redis["']/,
    "rate-limit.ts must `import { getRedis } from \"./redis\"` so the singleton is wired",
  );
  // The function body must call getRedis() — pinning the literal call
  // so a contributor can't keep the import and never use it.
  assert.match(
    src,
    /const\s+r\s*=\s*getRedis\(\)/,
    "rate-limit.ts rateLimit() must call `getRedis()` to obtain the shared client",
  );
});

test("spec 170 — rate-limit.ts preserves the FAIL-CLOSED contract from spec 163", () => {
  const src = read(RATE_LIMIT_PATH);
  // Spec 163's governance test already pins the literal phrase; we
  // re-pin here so a future spec-170 refactor can't silently delete
  // the JSDoc while routing the client through the singleton.
  assert.match(
    src,
    /FAIL-CLOSED/,
    "rate-limit.ts must STILL contain the FAIL-CLOSED phrase (the singleton refactor is supposed to preserve the security contract, not weaken it)",
  );
});

// ---------- (3) health.ts pingRedis delegates ----------

test("spec 170 — health.ts pingRedis delegates to ./redis's pingRedis", () => {
  const src = read(HEALTH_PATH);
  // The new shape imports pingRedis from ./redis and calls it; the
  // per-probe `new Redis(...)` construction is gone. The aliasing form
  // `{ pingRedis: ping }` (rename to avoid shadow of the outer
  // `pingRedis` function) is what the implementation actually uses.
  assert.match(
    src,
    /pingRedis(?:\s*:\s*ping|\s+as\s+ping)?\s*\}\s*=\s*await\s+import\(\s*["']\.\/redis["']\s*\)/,
    "health.ts must dynamically import { pingRedis } (optionally as `ping`) from \"./redis\" — the singleton-aware probe — inside its own pingRedis function",
  );
  // The old per-probe construction must be gone — pinning absence so
  // a future refactor that re-adds a local construction breaks the test.
  const stripped = stripComments(src);
  assert.ok(
    !/new\s+Redis\(url,\s*\{\s*connectTimeout/.test(stripped),
    "health.ts must not construct its own `new Redis(url, { connectTimeout: ... })` instance in executable code — the singleton handles the connection lifecycle",
  );
});

// ---------- (4) Forbidden page variants ----------

test("spec 170 — forbidden/page.tsx is a Server Component reading searchParams.reason", () => {
  const src = read(FORBIDDEN_PATH);
  // Server Component: the export must be async (so it can await
  // searchParams + auth()). A static function component can't read
  // session.user.locked_until.
  assert.match(
    src,
    /export\s+default\s+async\s+function\s+Forbidden/,
    "forbidden/page.tsx must be an async server component so it can read searchParams + call auth() for the locked variant",
  );
  // The searchParams prop must be a Promise<{ reason?: string }> per
  // Next.js 15's contract.
  assert.match(
    src,
    /searchParams\??\s*:\s*Promise<\s*\{\s*reason\?\s*:\s*string\s*\}\s*>/,
    "forbidden/page.tsx must accept `searchParams: Promise<{ reason?: string }>` per Next.js 15 dynamic-route conventions",
  );
});

test("spec 170 — forbidden/page.tsx renders all four copy variants", () => {
  const src = read(FORBIDDEN_PATH);
  // Each of the four reason values must appear as a string literal
  // somewhere in the source (as a branch in the resolveReason switch
  // or the if/else chain).
  for (const reason of ["locked", "smtp_unconfigured", "session_expired"]) {
    assert.match(
      src,
      new RegExp(`["']${reason}["']`),
      `forbidden/page.tsx must branch on the "${reason}" reason value so the variant copy renders`,
    );
  }
  // The four copy fragments — each pinned so a future contributor
  // can't accidentally collapse two variants into one shared message.
  assert.match(
    src,
    /temporarily locked due to too many failed login attempts/,
    "forbidden/page.tsx locked variant must include the 'temporarily locked due to too many failed login attempts' phrase",
  );
  assert.match(
    src,
    /Email-based actions/,
    "forbidden/page.tsx smtp_unconfigured variant must include the 'Email-based actions' phrase",
  );
  assert.match(
    src,
    /Your session has ended/,
    "forbidden/page.tsx session_expired variant must include the 'Your session has ended' phrase",
  );
  assert.match(
    src,
    /You don't have permission to view this page/,
    "forbidden/page.tsx default variant must include the 'You don't have permission to view this page' phrase",
  );
});

test("spec 170 — forbidden/page.tsx reads session.user.locked_until for the locked variant", () => {
  const src = read(FORBIDDEN_PATH);
  // The auth() call — load-bearing for the locked variant's "try
  // again in N minutes" computation. Future contributors removing
  // this would silently downgrade the locked variant to always say
  // "1 hour" — the test fails to keep them honest.
  assert.match(
    src,
    /(?:await\s+)?auth\(\)/,
    "forbidden/page.tsx must call `auth()` so the locked variant can read session.user.locked_until and format a concrete time-remaining hint",
  );
  // The locked_until field — pinning the exact column name so a
  // future rename trips the test.
  assert.match(
    src,
    /locked_until/,
    "forbidden/page.tsx must reference `locked_until` (the column name from spec 161) when computing time-remaining for the locked variant",
  );
  // The fallback string — pinned so the variant never just renders
  // "undefined" or "" when the session doesn't carry the column.
  assert.match(
    src,
    /["']1 hour["']/,
    "forbidden/page.tsx must fall back to '1 hour' when locked_until is absent (spec 161's default lockout duration is 1 hour)",
  );
});

test("spec 170 — forbidden/page.tsx carries data-testid and data-reason for governance / e2e pinning", () => {
  const src = read(FORBIDDEN_PATH);
  assert.match(
    src,
    /data-testid=["']forbidden-page["']/,
    "forbidden/page.tsx must carry data-testid=\"forbidden-page\" so e2e tests can locate the rendered surface",
  );
  assert.match(
    src,
    /data-reason=\{reason\}/,
    "forbidden/page.tsx must carry data-reason={reason} so the rendered variant is observable from the DOM (governance + e2e tests pin against this)",
  );
});

// ---------- (5) auth.ts AccountLockedError ----------

test("spec 170 — auth.ts declares AccountLockedError extending CredentialsSignin", () => {
  const src = read(AUTH_PATH);
  // The class declaration with the contracted code.
  assert.match(
    src,
    /class\s+AccountLockedError\s+extends\s+CredentialsSignin/,
    "auth.ts must declare `class AccountLockedError extends CredentialsSignin` so the locked-account path is distinguishable from generic bad-creds failures",
  );
  assert.match(
    src,
    /code\s*=\s*["']account_locked["']/,
    "auth.ts AccountLockedError must set `code = \"account_locked\"` so the loginAction can detect this specific failure case via err.code",
  );
  // The import of CredentialsSignin from next-auth — load-bearing
  // for the subclass to exist.
  assert.match(
    src,
    /import\s+[^;]*CredentialsSignin[^;]*from\s+["']next-auth["']/,
    "auth.ts must import `CredentialsSignin` from \"next-auth\" so the AccountLockedError can extend it",
  );
});

test("spec 170 — auth.ts throws AccountLockedError on the lockout path (not return null)", () => {
  const src = read(AUTH_PATH);
  // The throw site — pinning the literal `throw new AccountLockedError()`
  // so a future contributor can't accidentally revert to `return null`.
  assert.match(
    src,
    /throw\s+new\s+AccountLockedError\(\)/,
    "auth.ts must `throw new AccountLockedError()` on the locked-account branch so the loginAction can catch the distinct code and redirect to /forbidden?reason=locked",
  );
  // The spec 161 audit row MUST still fire before the throw — pinning
  // the relative order so a future refactor doesn't swap them.
  const lockedSection = src.match(
    /lockedUntil\s*>\s*new\s+Date\(\)[\s\S]+?throw\s+new\s+AccountLockedError\(\)/,
  );
  assert.ok(
    lockedSection,
    "auth.ts must keep the spec 161 audit row firing BEFORE the throw (search for the section from the lockedUntil check through the throw)",
  );
  assert.match(
    lockedSection[0],
    /"auth\.account\.locked_attempt"/,
    "auth.ts's locked-attempt audit row must still fire before the throw — pinning the order so SM-1 coverage is preserved on this code path",
  );
});

// ---------- (6) loginAction catches and redirects ----------

test("spec 170 — loginAction catches account_locked and redirects to /forbidden?reason=locked", () => {
  const src = read(LOGIN_ACTIONS_PATH);
  // The redirect import is required (the action used to just return
  // an error state; now it has a control-flow redirect for the locked
  // case).
  assert.match(
    src,
    /import\s*\{\s*redirect\s*\}\s*from\s*["']next\/navigation["']/,
    "loginAction must import `redirect` from \"next/navigation\" so the locked-case bounce works",
  );
  // The code-level detection — load-bearing pattern.
  assert.match(
    src,
    /code\s*===\s*["']account_locked["']/,
    "loginAction must detect `code === \"account_locked\"` on the caught AuthError to identify the locked-account failure case",
  );
  // The redirect target — pinned literal so a future typo (e.g.
  // /forbidden?reason=lock or /403?reason=locked) breaks the test.
  assert.match(
    src,
    /redirect\(\s*["']\/forbidden\?reason=locked["']\s*\)/,
    "loginAction must `redirect(\"/forbidden?reason=locked\")` on the account_locked branch so the user lands on the variant page with the right copy",
  );
  // The generic-error fallback must STILL be present for the
  // bad-creds / rate-limit-deny paths — preserving spec 141 contract.
  assert.match(
    src,
    /["']Invalid email or password["']/,
    "loginAction must keep the generic 'Invalid email or password' error for non-locked AuthError causes (spec 141 fail-closed contract preserved)",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 170 — no new dependencies introduced (ioredis + next-auth are pre-existing)", () => {
  const pkg = read("apps/web/package.json");
  // The spec uses the already-pinned ioredis (5.x) and the already-
  // pinned next-auth (v5.0.0-beta.25). No new redis client, no new
  // error-page library should have crept in.
  assert.ok(
    !/"redis"\s*:/.test(pkg),
    "apps/web must not depend on the `redis` package — the LMS-wide convention is ioredis, and the singleton uses ioredis",
  );
  assert.ok(
    !/"@upstash\/redis"/.test(pkg),
    "apps/web must not depend on @upstash/redis — the singleton uses the pre-existing local ioredis client",
  );
});

test("spec 170 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [
    REDIS_PATH,
    RATE_LIMIT_PATH,
    HEALTH_PATH,
    FORBIDDEN_PATH,
    AUTH_PATH,
    LOGIN_ACTIONS_PATH,
  ]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 170 — no remaining direct `new IORedis` / `new Redis` constructions in web src outside the singleton", () => {
  // The singleton in redis.ts is the only allowed direct construction
  // on the web side. rate-limit.ts and health.ts must have been
  // refactored to use it. Documentary mentions in comments (e.g.
  // "this module previously constructed `new Redis(url, ...)`") are
  // permitted, so strip comments before the absence-grep.
  for (const path of [RATE_LIMIT_PATH, HEALTH_PATH]) {
    const src = stripComments(read(path));
    assert.ok(
      !/new\s+(?:IO)?Redis\s*\(/.test(src),
      `${path} must not contain a direct \`new Redis(\` or \`new IORedis(\` construction in executable code — only the singleton at apps/web/src/lib/redis.ts is allowed to construct the client (comments mentioning the old shape are fine)`,
    );
  }
  // And the singleton MUST construct exactly one instance. Comments
  // can mention `new IORedis(...)` for documentation; strip them so
  // we only count the real construction.
  const singleton = stripComments(read(REDIS_PATH));
  const matches = singleton.match(/new\s+IORedis\s*\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `apps/web/src/lib/redis.ts must construct exactly one IORedis instance (the singleton); found ${matches.length}`,
  );
});
