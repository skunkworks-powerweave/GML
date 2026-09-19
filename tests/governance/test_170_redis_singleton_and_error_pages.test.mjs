// Governance test for spec 170 — Redis singleton and error-page variants
// (Workflow Run 16 post-audit hardening).
//
// THE REDIS HALF OF THIS FILE IS INVERTED. There is no Redis.
//
// Spec 170's diagnosis was right: three modules were each constructing their
// own ioredis client, and one shared singleton is better than three. The
// prescription was wrong, because it standardised on the wrong options.
//
// THE DEFECT THE SINGLETON MADE UNIFORM. `getRedis()` set
// `maxRetriesPerRequest: null`, supplied no `commandTimeout`, and left
// ioredis's offline queue at its default of enabled. Those three together mean
// that when Redis is unreachable a command does not reject -- it is buffered
// and retried forever. So `rateLimit()` never settled. The fail-closed `catch`
// that lib/rate-limit.ts documents at length, and that tests below still pin,
// was UNREACHABLE CODE: nothing ever rejected for it to catch. Every login
// request hung until the browser gave up. A rate limiter whose failure mode is
// to hang the endpoint it protects is a denial of service with extra steps, and
// the careful fail-closed documentation is what kept anyone from looking.
//
// Note what spec 170 did to that defect: it took one module's bad options and
// made them the house style, described in the assertions below as
// "worker-aligned defaults". Agreement is not correctness.
//
// Redis was also, separately, not worth its place -- one of eight services on a
// single EC2 box in Leh, for a queue carrying under 100 jobs a day. Both the
// counter and the queue now live in Postgres, on the pool the request already
// holds: an unreachable database rejects promptly, the catch runs, and if the
// database really is down the handler had nothing to serve anyway.
//
// The tests below therefore pin the ABSENCE of the singleton and of the options
// that made it dangerous, and the presence of the Postgres replacements. The
// error-page half of the file is untouched.
//
// Originally pinned (1)-(3), now inverted:
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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/**
 * Comments stripped, so this file's own documentation of what was removed --
 * which necessarily names the identifiers and options the absence checks
 * forbid -- cannot fail the checks that read the source it describes.
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every .ts/.tsx file under apps/web/src. */
function webSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(resolve(root, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
    }
  };
  walk("apps/web/src");
  return out;
}

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

// ---------- (1) The Redis singleton is gone ----------

test("spec 170 — apps/web/src/lib/redis.ts does not exist", () => {
  // INVERTED. This REQUIRED the file, `export function getRedis(): IORedis` and
  // `export async function pingRedis()`.
  //
  // Nothing in the web app talks to Redis any more: the rate limiter is a
  // Postgres upsert, the queue is a Postgres table, and the health probe that
  // pinged Redis was deleted along with the service. A surviving factory would
  // be a loaded gun -- an exported, typed, apparently-blessed way to reopen a
  // connection to a dependency the deployment no longer runs.
  assert.ok(
    !existsSync(resolve(root, REDIS_PATH)),
    `${REDIS_PATH} must not exist -- see this file's header for the options that made it dangerous`,
  );
});

test("spec 170 — the ioredis options that made failures HANG appear nowhere", () => {
  // INVERTED, and this is the assertion that matters most in the file.
  //
  // The original demanded all three of these, calling them "worker-aligned
  // defaults" and pinning them individually so that "a partial drift ... hits a
  // specific test failure". Together they are the bug:
  //
  //   maxRetriesPerRequest: null   -- retry a command forever, never give up
  //   (no commandTimeout)          -- and never time it out either
  //   (offline queue left enabled) -- and buffer it while disconnected
  //
  // The result is that a command issued while Redis is down never rejects. Not
  // slowly: never. `rateLimit()` never settled, its documented fail-closed
  // catch never ran, and login requests hung. Pinned as an absence across the
  // whole of apps/web/src, not just in the deleted file, because the shape is
  // what gets copied back in -- these exact options appear in every BullMQ
  // quickstart, where they are correct, because BullMQ manages its own
  // lifecycle and blocking commands. They were never correct for a
  // request-path client.
  const OFFENDERS = [
    [/maxRetriesPerRequest/, "retries a command forever instead of rejecting"],
    [/enableOfflineQueue/, "buffers commands while disconnected instead of rejecting"],
    [/enableReadyCheck/, "belongs to an ioredis client, and there is none"],
    [/lazyConnect/, "belongs to an ioredis client, and there is none"],
  ];
  for (const file of webSourceFiles()) {
    const src = code(read(file));
    for (const [pattern, why] of OFFENDERS) {
      assert.ok(
        !pattern.test(src),
        `${file}: \`${String(pattern.source)}\` must not appear -- it ${why}`,
      );
    }
  }
});

test("spec 170 — the rate limiter can actually reach its fail-closed path", () => {
  // INVERTED. The original pinned a "safe-never-throws" Redis probe:
  // try/catch around .ping(), a structured { ok: false, error } return, and a
  // 200-char slice on the message. That shape was right for a HEALTH probe,
  // whose job is to report rather than to decide.
  //
  // It is the wrong shape for a rate limiter, and the two were entangled in the
  // old design, because both went through a client that could not reject. The
  // limiter's contract is the opposite of never-throws: it must throw when it
  // cannot count, so the caller denies the request. What follows pins that the
  // throw is REACHABLE -- an unreachable one is what spec 170 shipped.
  const src = read(RATE_LIMIT_PATH);
  assert.match(
    src,
    /import\s*\{\s*db\s*\}\s*from\s*"@gml\/db"/,
    "rate-limit.ts must count in the same database the request already uses -- an " +
      "unreachable one rejects promptly, and if it is down the handler had nothing to serve",
  );
  // One statement. The Redis version counted inside a MULTI and added outside
  // it, so it raced anyway; the upsert serialises on the primary key.
  assert.match(
    src,
    /INSERT INTO rate_limits[\s\S]{0,600}?ON CONFLICT \(key\) DO UPDATE/,
    "the counter must be a single atomic upsert, not a read-modify-write",
  );
  assert.match(
    src,
    /if\s*\(!row\)\s*throw new Error\(/,
    "a RETURNING that yields no row must THROW -- returning ok:true there would be " +
      "the exact fail-open shape this module exists to prevent",
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

test("spec 170 — rate-limit.ts counts in Postgres and nothing imports a Redis client", () => {
  // INVERTED. This required `import { getRedis } from "./redis"` and a
  // `const r = getRedis()` call inside rateLimit(). The singleton was the right
  // instinct applied to a client that should not have existed; the counter is a
  // row in `rate_limits` now, keyed by bucket plus caller identity.
  //
  // The window changed shape with the transport, and the trade is worth
  // recording: the Redis version kept a sorted set of timestamps (a sliding
  // window); this keeps a count and a window start (a fixed window). Fixed
  // windows allow up to 2x the limit across a boundary -- for "5 attempts per
  // 15 minutes" the worst case is 10 in 15 minutes, which is not the difference
  // between safe and unsafe. What it buys is one atomic statement with no
  // read-modify-write race. The Redis version counted inside a MULTI and added
  // outside it, so its extra precision was notional anyway.
  assert.ok(
    !/getRedis/.test(code(read(RATE_LIMIT_PATH))),
    "rate-limit.ts must not reach for a Redis client",
  );
  for (const file of webSourceFiles()) {
    assert.ok(
      !/from\s*["']\.\.?\/(?:lib\/)?redis["']/.test(code(read(file))),
      `${file}: nothing may import ./redis -- the module is gone`,
    );
    assert.ok(
      !/from\s*["']ioredis["']/.test(code(read(file))),
      `${file}: nothing in apps/web may import ioredis`,
    );
  }
  // The key is scoped and length-capped, which the Redis version also did; kept
  // as an assertion because an unbounded key against a varchar(256) primary key
  // would turn a long caller identity into a 500 on the login path.
  assert.match(
    read(RATE_LIMIT_PATH),
    /`\$\{bucket\}:\$\{id\}`\.slice\(0,\s*256\)/,
    "the counter key must stay bucket-scoped and bounded to the column width",
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

// ---------- (3) health.ts has no Redis probe to delegate ----------

test("spec 170 — health.ts probes no service the deployment does not run", () => {
  // INVERTED. This required health.ts's own pingRedis to delegate to the
  // singleton's. There is no Redis to probe, so there is no probe.
  //
  // Deleting it rather than leaving it returning false is not tidiness. The
  // health route ANDs every probe into one `ok`, and returns 503 when that is
  // false. A probe for a service that does not exist is therefore permanently
  // false, which pins /api/health at 503 forever, which takes the container
  // HEALTHCHECK and the deploy script's `curl -fsS` readiness wait with it. The
  // stack would be healthy and unable to say so.
  const src = code(read(HEALTH_PATH));
  for (const gone of ["pingRedis", "pingMinio"]) {
    assert.ok(
      !new RegExp(`\\b${gone}\\b`).test(src),
      `health.ts must not declare ${gone} -- a probe for a deleted service pins /api/health at 503`,
    );
  }
  assert.ok(
    !/new\s+Redis\(/.test(src),
    "health.ts must not construct a Redis client",
  );
  // What remains: the database, which now covers both the queue and the
  // limiter, and Storage, which covers what MinIO used to.
  assert.match(
    read(HEALTH_PATH),
    /export\s+async\s+function\s+pingStorage\b/,
    "health.ts must export pingStorage in place of the deleted probes",
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

test("spec 170 — forbidden/page.tsx renders a distinct variant per reason", () => {
  const src = read(FORBIDDEN_PATH);

  // The `locked` variant is gone with the lockout that produced it (see
  // test_161 for why that machinery was a denial-of-service tool). It is
  // replaced by `rate_limited`, which is what Supabase Auth actually returns
  // when it throttles sign-in attempts -- a limit applied to the SOURCE of the
  // attempts rather than to the victim's account, so no stranger can trigger it
  // on someone else's behalf. `smtp_unconfigured` became `email_unavailable`
  // for the same reason the flag moved: SMTP is Supabase's concern now.
  for (const reason of ["rate_limited", "email_unavailable", "session_expired"]) {
    assert.match(
      src,
      new RegExp(`["']${reason}["']`),
      `forbidden/page.tsx must branch on the "${reason}" reason value`,
    );
  }
  assert.ok(
    !/["']locked["']/.test(src),
    "the `locked` variant must not return -- there is no account lockout to report",
  );

  // Each variant keeps its own copy, so a future contributor cannot collapse
  // two of them into one shared message and lose the distinction that made
  // this page worth building.
  assert.match(src, /Too many sign-in attempts/, "rate_limited copy");
  assert.match(src, /Email-based actions/, "email_unavailable copy");
  assert.match(src, /Your session has ended/, "session_expired copy");
});

test("spec 170 — forbidden/page.tsx does no session lookup", () => {
  // Comment-stripped: the file explains at length what was removed, naming the
  // very identifiers asserted against.
  const src = read(FORBIDDEN_PATH)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // It used to call auth() solely to read session.user.locked_until and format
  // a "try again in N minutes" hint. The column is gone, and with it the reason
  // to query anything from a page that is by definition rendered to people who
  // have just failed an authorization check.
  assert.ok(
    !/locked_until/.test(src),
    "forbidden/page.tsx must not reference locked_until -- the column no longer exists",
  );
  assert.ok(
    !/await\s+auth\(\)/.test(src),
    "forbidden/page.tsx must not call auth() -- it is a passive rendering surface",
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

test("spec 170 — auth.ts declares no bespoke sign-in error class", () => {
  const code = read(AUTH_PATH)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/AccountLockedError|CredentialsSignin/.test(code),
    "auth.ts must not declare a distinct locked-account error. It was an " +
      "ACCOUNT-EXISTENCE ORACLE: a caller who saw it learned that the address " +
      "was registered, which for an organisation with predictable addresses is " +
      "a staff roster. Sign-in failures are now one indistinguishable string.",
  );
});


// ---------- (6) loginAction catches and redirects ----------

test("spec 170 — loginAction surfaces one generic credential failure", () => {
  const src = read(LOGIN_ACTIONS_PATH);
  assert.match(
    src,
    /import\s*\{\s*redirect\s*\}\s*from\s*["']next\/navigation["']/,
    "loginAction still redirects on success",
  );
  assert.ok(
    !/account_locked/.test(src),
    "loginAction must not branch on a locked-account code",
  );
  assert.match(
    src,
    /safeNext\(/,
    "loginAction must validate its redirect target -- ?from= is attacker-supplied",
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
  // REDIS_PATH dropped from the sweep: the file is gone, and a test that reads
  // it throws ENOENT rather than reporting anything useful about hygiene.
  for (const path of [
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

test("spec 170 — zero Redis constructions anywhere in web src, singleton included", () => {
  // INVERTED from "exactly one, in the singleton" to "none, anywhere".
  //
  // The original allowed the singleton exactly one construction and forbade the
  // others, which was the correct rule for a codebase that still needed a
  // client. The count is zero now, and the sweep widens from two named files to
  // the whole tree, because the thing being guarded against changed. It is no
  // longer "a contributor adds a fourth client alongside the singleton" -- it
  // is "a contributor reintroduces Redis to solve a caching or rate-limiting
  // problem, reaches for the ioredis snippet everyone has memorised, and
  // restores the hang described in this file's header along with it".
  for (const file of webSourceFiles()) {
    const src = code(read(file));
    assert.ok(
      !/new\s+(?:IO)?Redis\s*\(/.test(src),
      `${file} must not construct a Redis client -- the counter and the queue are Postgres tables`,
    );
  }
  // The environment variable goes too. Left behind it is an invitation: a
  // configured REDIS_URL reads as a dependency the system supports.
  for (const file of webSourceFiles()) {
    assert.ok(
      !/REDIS_URL/.test(code(read(file))),
      `${file} must not read REDIS_URL -- there is no Redis to point it at`,
    );
  }
});
