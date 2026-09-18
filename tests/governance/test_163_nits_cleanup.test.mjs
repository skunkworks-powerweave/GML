// Governance test for spec 163 — NITS cleanup
// (Workflow Run 15 audit-closure, NIT round).
//
// Five files under audit:
//
//   1. apps/worker/src/log.ts (CREATED)
//      — exports `log` with info/warn/error methods that emit to
//        stderr with the [worker][<iso-timestamp>][<level>] prefix
//        and a trailing optional JSON fields payload.
//
//   2. apps/worker/src/index.ts (EDITED)
//      — every console.log / console.warn / console.error call
//        replaced with the matching log.* call; logger imported
//        from ./log.js.
//
//   3. apps/web/src/proxy.ts (EDITED)
//      — stale "once the auditing middleware lands in spec 010"
//        TODO removed; up-to-date Spec 163 note in its place.
//
//   4. apps/web/src/lib/rate-limit.ts (EDITED)
//      — multi-paragraph JSDoc block at the top of the module
//        documenting the FAIL-CLOSED contract.
//
//   5. packages/db/src/scripts/retention.ts (EDITED)
//      — isDirectInvocation() helper with basename fallback;
//        Spec 163 reference inline.
//
// Plus the verification that apps/web/src/components/nav/Topbar.tsx
// has no hardcoded "EN" literal outside comments.
//
// Plus the five spec-kit files under specs/163-nits-cleanup/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const LOG_PATH = "apps/worker/src/log.ts";
const WORKER_INDEX_PATH = "apps/worker/src/index.ts";
const MIDDLEWARE_PATH = "apps/web/src/proxy.ts";
const RATE_LIMIT_PATH = "apps/web/src/lib/rate-limit.ts";
const RETENTION_PATH = "packages/db/src/scripts/retention.ts";
const TOPBAR_PATH = "apps/web/src/components/nav/Topbar.tsx";
const SPEC_DIR = "specs/163-nits-cleanup";

// ---------- Spec-kit + plan.md contract ----------

test("spec 163 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the nits-cleanup spec`,
    );
  }
});

test("spec 163 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The five touched files must be named in plan.md so a reader auditing
  // the contract knows where the surface area actually lives.
  for (const file of ["log.ts", "index.ts", "middleware.ts", "rate-limit.ts", "retention.ts"]) {
    assert.match(
      src,
      new RegExp(file),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- (1) Worker logger ----------

test("spec 163 — apps/worker/src/log.ts exists and exports the log object with info/warn/error", () => {
  assert.ok(existsSync(resolve(root, LOG_PATH)), `${LOG_PATH} must exist as a new worker helper`);
  const src = read(LOG_PATH);
  // The helper MUST export a `log` object literal with the three
  // methods. We pin the export-shape rather than the implementation
  // so a future refactor (e.g. swapping the body for pino) doesn't
  // break the contract.
  assert.match(
    src,
    /export\s+const\s+log\s*=/,
    "log.ts must `export const log = { ... }` so callers can `import { log }`",
  );
  for (const method of ["info", "warn", "error"]) {
    assert.match(
      src,
      new RegExp(`${method}\\s*\\(`),
      `log object must declare an \`${method}\` method (matching the console.${method} surface it replaces)`,
    );
  }
});

test("spec 163 — log.ts emits the bracketed [worker][<ts>][<level>] format to stderr", () => {
  const src = read(LOG_PATH);
  // The literal prefix segments — pinning so a future contributor
  // can't silently drop the [worker] tag (the load-bearing prefix
  // for log-shipper filtering) or switch the timestamp format.
  assert.match(
    src,
    /\[worker\]/,
    "log.ts output format must include the literal `[worker]` prefix so log shippers have a stable filter target",
  );
  assert.match(
    src,
    /new\s+Date\(\)\.toISOString\(\)/,
    "log.ts must use `new Date().toISOString()` so the timestamp is machine-parseable (ISO 8601 / RFC 3339)",
  );
  // Output MUST go to stderr — the entire worker output channel is
  // consolidated there so Promtail / Loki shipper config can use a
  // single `stream=stderr` selector.
  assert.match(
    src,
    /process\.stderr\.write/,
    "log.ts must write to process.stderr so the production log shipper sees a single output channel",
  );
});

// ---------- (2) Worker index.ts uses the logger ----------

test("spec 163 — apps/worker/src/index.ts contains zero console.log / console.warn / console.error calls", () => {
  const src = read(WORKER_INDEX_PATH);
  // Pre-fix this file had six console calls. Post-fix it should
  // have zero — they all moved to log.info / log.warn / log.error.
  const lines = src.split(/\r?\n/);
  const offendingLines = lines.filter((line) => {
    const stripped = line.trim();
    // Skip comments so a documentary reference to "console.log" in
    // a JSDoc / inline comment doesn't false-positive.
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    return /\bconsole\.(log|warn|error)\s*\(/.test(line);
  });
  assert.deepEqual(
    offendingLines,
    [],
    "apps/worker/src/index.ts must contain no console.log / console.warn / console.error calls — all replaced with log.* (offending lines: " +
      offendingLines.join(" || ") +
      ")",
  );
});

test("spec 163 — apps/worker/src/index.ts imports the logger from ./log.js", () => {
  const src = read(WORKER_INDEX_PATH);
  // The import must be from ./log.js (with the .js extension — the
  // worker's tsconfig uses NodeNext-style explicit-extension imports,
  // see the queues.js / transcode.js imports already in the file).
  assert.match(
    src,
    /import\s*\{\s*log\s*\}\s*from\s*["']\.\/log\.js["']/,
    "apps/worker/src/index.ts must `import { log } from \"./log.js\"` so the logger is wired (note the explicit .js extension matches the existing queues.js / transcode.js imports)",
  );
});

test("spec 163 — apps/worker/src/index.ts carries an inline Spec 163 reference", () => {
  const src = read(WORKER_INDEX_PATH);
  assert.match(
    src,
    /Spec 163/,
    "apps/worker/src/index.ts must carry an inline `Spec 163` comment so the logger migration is self-documenting",
  );
});

// ---------- (3) Middleware stale TODO removed ----------

test("spec 163 — apps/web/src/proxy.ts no longer contains the stale spec-010 TODO", () => {
  const src = read(MIDDLEWARE_PATH);
  // The pre-fix phrase. Pin its ABSENCE so a future contributor
  // can't accidentally revert the cleanup by rebasing over an old
  // copy of the file.
  assert.ok(
    !/once the auditing middleware lands in spec 010/.test(src),
    "apps/web/src/proxy.ts must not contain the stale `once the auditing middleware lands in spec 010` TODO — spec 010 shipped long ago, the comment was misleading",
  );
});

test("spec 163 — apps/web/src/proxy.ts carries a Spec 163 reference", () => {
  const src = read(MIDDLEWARE_PATH);
  assert.match(
    src,
    /Spec 163/,
    "apps/web/src/proxy.ts must carry a `Spec 163` reference near the audit-log reminder so the cleanup is self-documenting",
  );
});

// ---------- (4) Rate-limit FAIL-CLOSED JSDoc ----------

test("spec 163 — apps/web/src/lib/rate-limit.ts carries a JSDoc block documenting FAIL-CLOSED", () => {
  const src = read(RATE_LIMIT_PATH);
  // The literal "FAIL-CLOSED" phrase. Pin so a future contributor
  // who wants to "soften" the doc into "fail closed" (no caps, no
  // hyphen) hits the governance test diff. The capitalised form is
  // intentional — it's a load-bearing security contract, the doc
  // wants to YELL it at the reader.
  assert.match(
    src,
    /FAIL-CLOSED/,
    "apps/web/src/lib/rate-limit.ts must contain the literal `FAIL-CLOSED` phrase in the top-of-module JSDoc (the capitalised hyphenated form is the load-bearing security-contract pin)",
  );
  // The JSDoc must include the literal "throw" word so a reader
  // hovering the function in their IDE sees the THROW behaviour,
  // not just the success-shape return type.
  assert.match(
    src,
    /\bthrow/i,
    "apps/web/src/lib/rate-limit.ts JSDoc must mention `throw` so the IDE-hover surface tells the caller about the failure path, not just the success path",
  );
  // The block must include a worked caller example showing the
  // correct try/catch shape. We pin the literal string "try" + "503"
  // — the example uses "503 Service Unavailable" as the canonical
  // response code on Redis outage, matching the spec 141 contract.
  assert.match(
    src,
    /try\s*\{[\s\S]{0,300}rateLimit\(/,
    "apps/web/src/lib/rate-limit.ts JSDoc must include a worked caller example showing the try { rateLimit(...) } pattern",
  );
  assert.match(
    src,
    /503/,
    "apps/web/src/lib/rate-limit.ts JSDoc example must reference status 503 (the canonical response on Redis outage per spec 141)",
  );
});

// ---------- (5) Retention basename-fallback guard ----------

test("spec 163 — packages/db/src/scripts/retention.ts defines isDirectInvocation() with the basename fallback", () => {
  const src = read(RETENTION_PATH);
  // The helper function declaration. Pinning the exact name so a
  // future contributor can't silently inline the logic back into
  // the if-statement (which would defeat the readability win the
  // helper provides).
  assert.match(
    src,
    /function\s+isDirectInvocation\s*\(\s*\)\s*:\s*boolean/,
    "packages/db/src/scripts/retention.ts must declare `function isDirectInvocation(): boolean` to wrap the entry-point guard logic",
  );
  // The `basename` import from node:path — load-bearing for the
  // fallback. The original guard had no path-manipulation imports
  // beyond `pathToFileURL` from node:url.
  assert.match(
    src,
    /import\s*\{\s*basename\s*\}\s*from\s*["']node:path["']/,
    "packages/db/src/scripts/retention.ts must `import { basename } from \"node:path\"` for the fallback comparison",
  );
  // The `fileURLToPath` import — needed to convert import.meta.url
  // back to a filesystem path before comparing basenames.
  assert.match(
    src,
    /fileURLToPath/,
    "packages/db/src/scripts/retention.ts must use fileURLToPath to convert import.meta.url to a filesystem path for the basename comparison",
  );
  // The fallback comparison itself — `basename(selfPath) === basename(argvPath)`.
  assert.match(
    src,
    /basename\s*\([^)]+\)\s*===\s*basename\s*\(/,
    "packages/db/src/scripts/retention.ts isDirectInvocation must include the `basename(...) === basename(...)` fallback comparison so symlinked invocations still auto-run",
  );
});

test("spec 163 — packages/db/src/scripts/retention.ts carries a Spec 163 reference", () => {
  const src = read(RETENTION_PATH);
  assert.match(
    src,
    /Spec 163/,
    "packages/db/src/scripts/retention.ts must carry a `Spec 163` comment explaining the fallback is defensive only",
  );
});

// ---------- (6) Topbar — no hardcoded EN ----------

test("spec 163 — Topbar.tsx has no hardcoded \"EN\" literal outside comments", () => {
  const src = read(TOPBAR_PATH);
  const lines = src.split(/\r?\n/);
  // Strip out lines that are pure comments (start with // or *) so a
  // documentary reference to the "EN" locale in a JSDoc block doesn't
  // false-positive. The load-bearing regex looks for a JSX text node
  // (`>EN<`) or a literal `"EN"` / `'EN'` string in non-comment lines.
  const offendingLines = lines.filter((line) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    // Match `>EN<` (JSX text node) or `"EN"` / `'EN'` (literal string).
    return />EN</.test(line) || /["']EN["']/.test(line);
  });
  assert.deepEqual(
    offendingLines,
    [],
    "apps/web/src/components/nav/Topbar.tsx must not contain a hardcoded `\"EN\"` / `'EN'` / `>EN<` literal — the LanguagePicker island handles the chip rendering (offending lines: " +
      offendingLines.join(" || ") +
      ")",
  );
});

test("spec 163 — Topbar.tsx still imports and renders LanguagePicker", () => {
  const src = read(TOPBAR_PATH);
  // Belt-and-suspenders: pin presence of LanguagePicker too so a
  // future contributor can't "fix" the absence test by simply
  // ripping out the picker. Spec 155 already covers this but
  // duplicating the check here makes the NIT contract complete.
  assert.match(
    src,
    /import\s+LanguagePicker\s+from\s+["']\.\/LanguagePicker["']/,
    "apps/web/src/components/nav/Topbar.tsx must still import LanguagePicker from ./LanguagePicker (spec 155 island)",
  );
  assert.match(
    src,
    /<LanguagePicker\b/,
    "apps/web/src/components/nav/Topbar.tsx must still render a <LanguagePicker /> element so the language UI remains present",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 163 — no new dependencies were introduced (no pino, winston, debug, lodash.basename)", () => {
  // The fix is a hand-rolled stderr.write shim + node stdlib basename.
  // No logger library, no path-utility wrapper should have crept into
  // either apps/worker/package.json or packages/db/package.json.
  const workerPkg = read("apps/worker/package.json");
  const dbPkg = read("packages/db/package.json");
  for (const pkg of [workerPkg, dbPkg]) {
    assert.ok(
      !/"pino"/.test(pkg),
      "apps/worker / packages/db must not depend on pino — the logger is a hand-rolled stderr.write shim",
    );
    assert.ok(
      !/"winston"/.test(pkg),
      "apps/worker / packages/db must not depend on winston — same reason",
    );
    assert.ok(
      !/"debug"/.test(pkg),
      "apps/worker / packages/db must not depend on debug — the logger is always-on production logging, not opt-in dev spew",
    );
  }
});

test("spec 163 — no TODO / FIXME / placeholder markers leaked into shipped source for the NITS files", () => {
  for (const path of [LOG_PATH, WORKER_INDEX_PATH, MIDDLEWARE_PATH, RATE_LIMIT_PATH, RETENTION_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers — the NITS round explicitly cleaned them up`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
