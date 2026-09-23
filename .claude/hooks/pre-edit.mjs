#!/usr/bin/env node
// PreToolUse gate for Edit | Write | MultiEdit.
//
// ── WHY THIS HOOK FILTERS PATHS ITSELF ───────────────────────────────────────
//
// The old settings.json declared three "path-scoped" Edit hooks using a
// `pathGlob` field that appears ZERO times in the installed Claude Code binary.
// There is no such config key, so those hooks fired on EVERY Edit and Write and
// then did nothing useful with the file they were handed. This hook is
// registered for all of Edit|Write|MultiEdit and does its own matching on
// tool_input.file_path, which is the only arrangement that actually works.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  PROJECT_DIR,
  allow,
  allowIfOverridden,
  currentBranch,
  deny,
  git,
  readInput,
  receipts,
} from "./_lib.mjs";

/** Tools that carry a file_path this gate understands. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * The edit target as a repo-relative, forward-slashed path.
 *
 * Claude Code sends an absolute path, and on Windows it is backslashed, so
 * every comparison below would silently never match without this. Returns
 * { rel, outside } — `outside` is true when the target lives beyond this
 * repository, which most rules deliberately ignore.
 */
function targetPath(filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(PROJECT_DIR, filePath);
  const rel = relative(PROJECT_DIR, abs).split("\\").join("/");
  return { rel, outside: rel === "" || rel.startsWith("../") };
}

const basename = (p) => p.split("/").pop() ?? "";

// ── 1. PROTECTED FILES ───────────────────────────────────────────────────────
//
// No override on these two. An escape hatch that can unlock a .env is an escape
// hatch that will be used to unlock a .env, and the cost of being wrong here
// (a leaked secret, a migration lane that no longer matches its journal) is not
// symmetrical with the cost of asking a human to do it by hand.

/** `.env` and every `.env.<suffix>` except the committed example. */
function isEnvFile(rel) {
  const name = basename(rel);
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

/**
 * A drizzle snapshot under packages/db/src/migrations/meta/.
 *
 * drizzle-kit derives the next migration by diffing the newest snapshot. Edit
 * one by hand and the snapshot no longer describes the SQL the journal claims
 * was applied, so the next `generate` emits a migration that is wrong in a way
 * nothing in CI can see.
 */
function isDrizzleSnapshot(rel) {
  return /(^|\/)packages\/db\/src\/migrations\/meta\/[^/]*_snapshot\.json$/i.test(rel);
}

// ── 2. NO EDITS ON main / master ─────────────────────────────────────────────
//
// Every one of this project's 27 commits landed directly on the integration
// branch, which is why "revert the bad change" has never once been a one-line
// answer here. The refusal below is overridable, but it hands over the exact
// worktree command: a gate that says "use a branch" and leaves you to remember
// the invocation is a gate that gets skipped out of impatience rather than
// disagreement.
const INTEGRATION_BRANCHES = new Set(["main", "master"]);

/**
 * workspace/ is runtime scratch — receipts, logs, session notes — and is
 * gitignored, so writing there on main cannot dirty the branch. Exempting it
 * keeps the gate from blocking the very files the other gates write.
 */
const isScratch = (rel) => rel.startsWith("workspace/");

/** The override footer, shown only on refusals that actually have a hatch. */
const HATCH =
  'Override (recorded in workspace/gate-overrides.log): set GML_GATE_SKIP="<why>" for the call.';

// ── 3. TEST-FIRST NUDGE ──────────────────────────────────────────────────────
//
// Every test in this project's history shipped in the same commit as the code
// it tests, and at least 28 assertions were written to match what the code
// already did — pinning the defect rather than catching it. A hook cannot prove
// a test was written first; there is no such observation to make. What it CAN
// do is refuse to let source move while there is no sign of a test at all, and
// say out loud that that is all it is doing. Overstating it ("TDD verified")
// would just be the ledger's `1549/1549 passing` all over again.

/** Source held to the nudge: apps/<pkg>/src/... and packages/<pkg>/src/... */
const isSourcePath = (rel) => /^(apps|packages)\/.+\/src\/.+/.test(rel);

/** Anything that IS a test (or a type declaration) is never blocked by it. */
function isTestish(rel) {
  const name = basename(rel);
  return (
    /(^|\/)tests\//.test(rel) ||
    /\.(test|spec)\./.test(name) ||
    name.endsWith(".d.ts")
  );
}

/** A test at any tier: top-level tests/..., and a package's own apps/web/tests/... */
const isTestPath = (rel) => /(^|\/)tests\//.test(rel);

/**
 * Paths git reports as modified, added, renamed or untracked.
 *
 * `-uall` is not optional: plain `--porcelain` collapses an untracked
 * directory to `?? tests/`, which would make a brand-new tests/behaviour file
 * indistinguishable from a brand-new tests/governance one — and rule 4 turns
 * exactly on that distinction. `-z` avoids git's path quoting rules entirely.
 *
 * Paths that no longer exist on disk are dropped. git reports a deleted file as
 * changed, so without this, `rm tests/behaviour/thing.test.ts` would satisfy
 * "you touched a test" — the one move that makes the tree LESS tested would
 * unlock the gate. It also disposes of the second chunk of a rename record
 * (the old path), which carries no status bytes and is not a real target.
 */
function changedPaths() {
  const out = git(["status", "--porcelain", "-uall", "-z"]);
  if (!out) return [];
  return out
    .split("\0")
    .filter(Boolean)
    .map((chunk) => {
      // "XY path"; a rename's second chunk is a bare path with no status bytes.
      const m = /^(..) ([\s\S]*)$/.exec(chunk);
      return (m ? m[2] : chunk).split("\\").join("/");
    })
    .filter((rel) => existsSync(resolve(PROJECT_DIR, rel)));
}

/**
 * RED evidence: a receipt from this branch that recorded a FAILING run.
 *
 * Scoped to commits since the merge-base with main, so a failure from work
 * that is already merged cannot license today's edit. When the merge-base
 * cannot be resolved (no main, unborn branch, a fresh clone) the scoping is
 * dropped rather than the whole condition: refusing every edit because git
 * could not answer a question would be the gate failing closed on its own
 * uncertainty, which is how gates get switched off.
 */
function hasRedReceipt(branch) {
  const base = git(["merge-base", "main", "HEAD"]);
  let scope = null;
  if (base) {
    const heads = git(["rev-list", `${base}..HEAD`]);
    scope = new Set(heads ? heads.split(/\r?\n/).filter(Boolean) : []);
    const head = git(["rev-parse", "HEAD"]);
    if (head) scope.add(head);
  }
  return receipts().some(
    (r) =>
      r &&
      r.branch === branch &&
      typeof r.exitCode === "number" &&
      r.exitCode !== 0 &&
      (!scope || !r.head || scope.has(r.head)),
  );
}

// ── 4. SECURITY SURFACES NEED A BEHAVIOUR TEST ───────────────────────────────
//
// tests/governance/ regex-matches source text; it cannot observe a runtime
// behaviour, and it was green for months while the application returned HTTP
// 500 on its own login page. On these files, being wrong means an unauthorised
// read or an unthrottled endpoint, so a governance test is not accepted as the
// touched test — only tests/behaviour/, which runs real code against real
// Postgres. Note this narrows condition (a) ONLY: a RED receipt or a live
// exemption still clears the nudge, because both of those are evidence about a
// run rather than about a file's path.
const SECURITY_SURFACES = new Set([
  "apps/web/src/proxy.ts",
  "apps/web/src/lib/authz.ts",
  "apps/web/src/lib/gates.ts",
  "apps/web/src/lib/rate-limit.ts",
  "apps/web/src/lib/request-ip.ts",
]);

const isSecuritySurface = (rel) =>
  SECURITY_SURFACES.has(rel) || /^packages\/db\/src\/schema\//.test(rel);

/** The two behaviour tiers. Governance and integration do not qualify here. */
const isBehaviourTestPath = (rel) =>
  /^tests\/behaviour\//.test(rel) || /^apps\/web\/tests\/behaviour\//.test(rel);

/** The hard cap on a self-declared exemption. */
const EXEMPTION_CAP_MS = 60 * 60 * 1000;

/**
 * A deliberate, time-boxed exemption: workspace/tdd-exempt.json.
 *
 * An exemption that never expires is a permanent hole, so one that claims more
 * than an hour is ignored outright rather than clamped — clamping would let a
 * file that says "expires in 2030" keep working, and the file is meant to be
 * re-stated by a human who still thinks it is warranted.
 */
function exemptionActive() {
  const p = resolve(PROJECT_DIR, "workspace", "tdd-exempt.json");
  if (!existsSync(p)) return false;
  try {
    const { reason, expiresAt } = JSON.parse(readFileSync(p, "utf8"));
    if (typeof reason !== "string" || reason.trim() === "") return false;
    const exp = Date.parse(expiresAt);
    if (!Number.isFinite(exp)) return false;
    const now = Date.now();
    return exp > now && exp - now <= EXEMPTION_CAP_MS;
  } catch {
    return false;
  }
}

function main() {
  const input = readInput();

  // Defensive: the hook may be registered for a wider matcher than intended,
  // and a gate that blocks a tool it does not understand is a gate that gets
  // deleted. Anything unrecognised passes straight through.
  const tool = input?.tool_name;
  if (tool && !EDIT_TOOLS.has(tool)) allow();

  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath === "") allow();

  const { rel, outside } = targetPath(filePath);

  if (isEnvFile(rel)) {
    deny(
      `[pre-edit] ${basename(rel)} is a protected file — secrets are never written by an agent.\n` +
        "Way forward: put the KEY and a placeholder in .env.example (that file is editable),\n" +
        "then ask the human to fill the real value in their own .env by hand.",
    );
  }

  if (isDrizzleSnapshot(rel)) {
    deny(
      `[pre-edit] ${rel} is a generated drizzle snapshot — hand-editing it desynchronises\n` +
        "the snapshot from the migration journal, and the next generated migration is then\n" +
        "wrong in a way no test can see.\n" +
        "Way forward: change packages/db/src/schema/**, then regenerate with drizzle-kit\n" +
        "(pnpm --filter @gml/db generate) and commit the SQL, the journal and the snapshot together.",
    );
  }

  // Everything past this point is about THIS repository. A file somewhere else
  // on disk is another repository's business (and has its own hooks).
  if (outside) allow();

  const branch = currentBranch();

  if (INTEGRATION_BRANCHES.has(branch) && !isScratch(rel)) {
    allowIfOverridden("", "no-edits-on-main");
    deny(
      `[pre-edit] Refusing to edit ${rel} on \`${branch}\`.\n` +
        `Rule: ${branch} is the integration branch — changes arrive on it by merge, not by\n` +
        "typing. Editing here is how 27 commits of this project's history ended up with no\n" +
        "reviewable branch to revert.\n" +
        "Way forward — make a worktree and redo the edit there:\n" +
        "  git worktree add ../<slug> -b <type>/<slug>\n" +
        `${HATCH}`,
    );
  }

  if (!isSourcePath(rel) || isTestish(rel)) allow();

  // Cheapest sufficient evidence first: this hook runs on EVERY edit, and each
  // condition below costs more than the one before it (one `git status`, then
  // a stat, then up to three more git calls). The common case — a developer
  // with a test file open — settles in the first check.
  const guarded = isSecuritySurface(rel);
  const touched = changedPaths().filter(isTestPath);
  if (touched.some(guarded ? isBehaviourTestPath : () => true)) allow();

  if (exemptionActive()) allow();
  if (hasRedReceipt(branch)) allow();

  if (guarded) {
    allowIfOverridden("", "security-surface-behaviour-test");
    deny(
      `[pre-edit] Refusing to edit ${rel}: it is a security surface, and the only tests\n` +
        `touched here are outside tests/behaviour/${touched.length ? ` (${touched.slice(0, 3).join(", ")})` : ""}.\n` +
        "Rule: on the files where being wrong means an unauthorised read or an unthrottled\n" +
        "endpoint, the touched test must be a BEHAVIOUR test — tests/behaviour/ or\n" +
        "apps/web/tests/behaviour/.\n" +
        "Why a governance test does not count: tests/governance/ regex-matches source text.\n" +
        "It can see that this file mentions a guard; it cannot see whether the guard runs,\n" +
        "denies, or is reachable at all. That suite was green for months while the app\n" +
        "returned HTTP 500 on its own login page.\n" +
        "Way forward: write the failing case in tests/behaviour/ (real code, real Postgres),\n" +
        "run it, see it RED — then come back. A RED receipt on this branch also clears this.\n" +
        `${HATCH}`,
    );
  }

  allowIfOverridden("", "test-first");
  deny(
    `[pre-edit] Refusing to edit ${rel}: nothing in this working tree suggests a test came first.\n` +
      "Iron Law: the failing test is written, RUN, and SEEN to fail before the code that makes\n" +
      "it pass. Every test in this project's history shipped in the same commit as its code, and\n" +
      "28 of those assertions were written to match a defect instead of catching it.\n" +
      "This check is a NUDGE, not proof — it cannot see the order you wrote things in, only\n" +
      "whether any of the three signs below exist. Any one of them clears it:\n" +
      "  1. touch the test — any modified or untracked file under tests/ (any tier)\n" +
      "  2. show RED — run `pnpm test` with the new test failing; the receipt in\n" +
      "     workspace/test-receipts.jsonl records the non-zero exit\n" +
      '  3. time-box it — workspace/tdd-exempt.json {"reason":"...","expiresAt":"<ISO, max 60 min>"}\n' +
      `${HATCH}`,
  );
}

// A hook must never crash.
//
// Checked in the installed CLI rather than assumed: exit 2 is the "blocking
// error"; any OTHER non-zero exit is dispatched as `hook_non_blocking_error`
// ("Failed with non-blocking status code: ..."), and the tool call proceeds. So
// an uncaught throw does not block anything — it just turns this gate off
// silently while dumping a stack trace on every edit, which is the state the
// previous hooks were in for the life of the project. Catching it keeps the
// failure legible and the message one line long.
try {
  main();
} catch (err) {
  process.stderr.write(`[pre-edit] gate skipped — internal error: ${err?.message ?? err}\n`);
  allow();
}
