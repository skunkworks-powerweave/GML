// rate_limits must actually be pruned, by the job that actually runs.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// apps/web/src/lib/rate-limit.ts defined pruneRateLimits() under a docstring
// saying it was "Called from the nightly retention job". Nothing called it --
// a repo-wide search found exactly one hit, the definition -- and nothing
// could have: that file starts with `import "server-only"`, and apps/worker,
// which runs the nightly job, has never imported from apps/web. The nightly
// job deleted notifications and nothing else.
//
// So rate_limits kept one permanent row per distinct caller, and its keys are
// IP-bearing: `login-link:<ip>`, `gate:<ip>:<userId>:<section>`. The table was
// an indefinite log of which address tried to sign in, as whom, and when --
// for a programme handling teacher and learner data -- with no retention
// policy and no mention in any operator document.
//
// ── WHAT THESE PIN ───────────────────────────────────────────────────────────
//
// The reaper lives in @gml/db beside deleteOldNotifications(), where the worker
// can reach it; the worker's nightly job calls it; the CLI calls it; and there
// is one copy. These read source text. tests/behaviour/retention-sweep.test.ts
// runs the DELETE against a real Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
/** Comments stripped, so prose describing a removal cannot satisfy a match. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const WORKER = "apps/worker/src/index.ts";
const RETENTION = "packages/db/src/scripts/retention.ts";
const WEB_LIMITER = "apps/web/src/lib/rate-limit.ts";

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("pruneRateLimits is defined exactly once, in @gml/db's retention module", () => {
  const defs = [];
  for (const top of ["apps", "packages"]) {
    for (const f of sourceFiles(resolve(root, top))) {
      if (/\bfunction\s+pruneRateLimits\b|\bpruneRateLimits\s*=\s*(?:async\s*)?\(/.test(code(readFileSync(f, "utf8")))) {
        defs.push(relative(root, f).split("\\").join("/"));
      }
    }
  }
  assert.deepEqual(
    defs,
    [RETENTION],
    "one copy, on the side of the fence the worker can import. A copy in apps/web/src/lib " +
      "(behind `import \"server-only\"`) is unreachable from apps/worker.",
  );
  assert.match(
    code(read(RETENTION)),
    /export\s+async\s+function\s+pruneRateLimits\s*\(/,
    `${RETENTION} must export pruneRateLimits()`,
  );
});

test("the worker's nightly retention job runs pruneRateLimits", () => {
  const src = code(read(WORKER));
  assert.match(
    src,
    /import\s*\{[^}]*\bpruneRateLimits\b[^}]*\}\s*from\s*["']@gml\/db\/scripts\/retention["']/,
    "the worker must import pruneRateLimits from @gml/db/scripts/retention",
  );
  // The arm of the dispatch switch that scheduleDailyWork() actually enqueues.
  const arm = src.match(/case\s+["']deleteOldNotifications["']\s*:\s*\{([\s\S]*?)\bbreak\s*;/);
  assert.ok(arm, "could not find the deleteOldNotifications arm of the worker's job switch");
  assert.match(
    arm[1],
    /\bawait\s+pruneRateLimits\s*\(/,
    "the nightly job must prune rate_limits -- calling it only from the CLI's main() " +
      "would reproduce the defect, because the worker never runs main()",
  );
  // And it is still the job that gets scheduled -- a new job name that nothing
  // enqueues, or that the switch does not know, is the same dead end again.
  assert.match(
    src,
    /enqueue\(\s*db\s*,\s*\{[\s\S]{0,300}?name\s*:\s*["']deleteOldNotifications["']/,
    "scheduleDailyWork() must still enqueue the job whose arm runs the prune",
  );
});

test("the retention CLI prunes rate_limits too", () => {
  const src = code(read(RETENTION));
  const main = src.match(/export\s+async\s+function\s+main\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(main, `could not find main() in ${RETENTION}`);
  assert.match(main[1], /\bawait\s+pruneRateLimits\s*\(/, "`pnpm --filter @gml/db retention` must prune rate_limits");
});

test("the web limiter no longer claims a caller that does not exist", () => {
  const src = read(WEB_LIMITER);
  assert.ok(
    !/Called from the nightly retention job/.test(src),
    `${WEB_LIMITER} must not claim its prune is called nightly -- that sentence is what ` +
      "told the IT team housekeeping was already wired",
  );
});

test("the IT reference states how long rate_limits (and so client IPs) are kept", () => {
  const src = read("README-IT.md");
  assert.match(src, /rate_limits/, "README-IT.md must say what happens to rate_limits");
  assert.match(src, /24 hours/, "README-IT.md must state the rate_limits retention period");
});
