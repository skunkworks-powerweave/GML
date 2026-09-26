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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_DIR,
  allow,
  allowIfOverridden,
  appendWorkspace,
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

/**
 * The path as the FILESYSTEM will resolve it, not as it happened to be typed.
 *
 * EVERY predicate in this file goes through this, because every one of them
 * used to compare the literal string, and this project runs on Windows only.
 * Two facts made that a bypass rather than a filter:
 *
 *   case      NTFS is case-insensitive. `.ENV` opens `.env`; a Write to it was
 *             ALLOWED, and writing through the name replaced the real file's
 *             bytes. `APPS/WEB/SRC/LIB/AUTHZ.TS` opens the security surface
 *             `apps/web/src/lib/authz.ts` and dropped out of isSourcePath
 *             entirely, clearing the test-first rule for the whole tree.
 *
 *   streams   `.env::$DATA` is NTFS syntax for the DEFAULT data stream of
 *             `.env` — the same bytes, spelled differently — and it too was
 *             ALLOWED and too clobbered `.env`. `.env:x` names a second stream
 *             of the same file object. A basename never legitimately contains
 *             a colon on Windows, so everything from the first one is cut.
 *
 * What this deliberately does NOT do is strip a trailing dot or space. That is
 * a Win32 API behaviour and Node does not have it: Node prefixes `\\?\` and
 * asks for the literal name, so `.env.` and `.env ` really are distinct files
 * (ENOENT against a real `.env` — the test asserts that before asserting the
 * verdict). Refusing them would be a rule that defends nothing, and a rule that
 * defends nothing is how a gate loses the argument for the rules that do.
 *
 * Normalising INSIDE each predicate rather than once in main() is deliberate
 * too: a caller cannot then forget, and a predicate added later gets it free.
 */
function pathKey(rel) {
  const cut = rel.lastIndexOf("/") + 1;
  return (rel.slice(0, cut) + rel.slice(cut).split(":")[0]).toLowerCase();
}

// ── 1. PROTECTED FILES ───────────────────────────────────────────────────────
//
// No override on these two. An escape hatch that can unlock a .env is an escape
// hatch that will be used to unlock a .env, and the cost of being wrong here
// (a leaked secret, a migration lane that no longer matches its journal) is not
// symmetrical with the cost of asking a human to do it by hand.

/**
 * `.env` and every `.env.<suffix>` except the committed example.
 *
 * The exception is compared against the case-folded name for the same reason
 * the rule is: `.env.EXAMPLE` IS `.env.example` here, and refusing it made the
 * refusal above contradict its own way forward — "go and edit .env.example",
 * followed by a second refusal when you did.
 */
function isEnvFile(rel) {
  const name = basename(pathKey(rel));
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

/**
 * A drizzle snapshot under packages/db/src/migrations/meta/.
 *
 * drizzle-kit derives the next migration by diffing the newest snapshot. Edit
 * one by hand and the snapshot no longer describes the SQL the journal claims
 * was applied, so the next `generate` emits a migration that is wrong in a way
 * nothing in CI can see.
 *
 * The `/i` flag this pattern used to carry is gone, not lost: pathKey already
 * case-folds, and one rule about case is better than two that can disagree.
 * What the flag never covered was `_snapshot.json::$DATA`, which pathKey does.
 */
function isDrizzleSnapshot(rel) {
  return /(^|\/)packages\/db\/src\/migrations\/meta\/[^/]*_snapshot\.json$/.test(pathKey(rel));
}

// ── 1b. THE GATE FILES THEMSELVES ────────────────────────────────────────────
//
// Verified before this rule existed: a Write to `.claude/hooks/pre-bash.mjs`,
// to `.claude/hooks/_lib.mjs` and to `.claude/settings.json` was ALLOWED. One
// edit switches the whole layer off and nothing anywhere says a word — which is
// exactly how the six hooks this replaces stayed dead for the life of the
// project while every session looked like one where the gates happened to pass.
//
// The protected set is the EXECUTABLE surface only. `.claude/hooks/README.md`
// describes the gates and enforces nothing, so gating it would only teach
// people that this rule is noise.
// Exported for the same reason as SECURITY_SURFACES below: the suite asserts
// against the real list rather than a copy of it, so the list cannot shrink in
// here while the tests go on reporting that it did not.
export const GATE_SETTINGS = new Set([".claude/settings.json", ".claude/settings.local.json"]);

function isGateFile(rel) {
  const key = pathKey(rel);
  return GATE_SETTINGS.has(key) || /^\.claude\/hooks\/[^/]+\.mjs$/.test(key);
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
const isScratch = (rel) => pathKey(rel).startsWith("workspace/");

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
const isSourcePath = (rel) => /^(apps|packages)\/.+\/src\/.+/.test(pathKey(rel));

/**
 * A test TIER root: the top-level `tests/`, or a package's own `tests/`.
 *
 * This was `/(^|\/)tests\//` — ANY directory named `tests` at ANY depth,
 * including `apps/web/src/tests/`, which is INSIDE the very tree the nudge
 * exists to guard. So `mkdir apps/web/src/tests` and dropping a file in it both
 * exempted that file AND counted as "you touched a test" for every other file
 * in the repository. Measured against this tree, the only directory named
 * `tests/` that exists anywhere is the top-level one, so the width bought
 * nothing and sold the rule.
 */
const TEST_TIER = /^(tests\/|(apps|packages)\/[^/]+\/tests\/)/;

/**
 * A file that IS a test: the marker is the LAST suffix before the extension.
 *
 * `/\.(test|spec)\./` matched anywhere in the name, so `thing.test.helper.ts` —
 * a helper that sits beside a test and is not one — skipped the nudge, as did
 * `x.test.data.json`. And `.spec.` is gone entirely: 144 files in this tree
 * match `.test.`, ZERO match `.spec.`, and no script in package.json globs for
 * one, so honouring it widened the exemption to a convention this project does
 * not use and does not run.
 */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Anything that IS a test (or a type declaration) is never blocked by it. */
function isTestish(rel) {
  const key = pathKey(rel);
  const name = basename(key);
  return TEST_TIER.test(key) || TEST_FILE.test(name) || name.endsWith(".d.ts");
}

/**
 * A test at any tier: top-level tests/..., and a package's own apps/web/tests/...
 *
 * Shares TEST_TIER with isTestish on purpose. They were two copies of one
 * regex, which is the drift this codebase keeps paying for — tightening the
 * exemption while leaving the evidence rule wide would have been half a fix.
 */
const isTestPath = (rel) => TEST_TIER.test(pathKey(rel));

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
 *
 * `keep` is applied BEFORE the existence check because it is a regex on a
 * string while existsSync is a syscall per path. The only caller wants test
 * paths, so on a tree with a few hundred changed files this is a few hundred
 * stats the gate was doing and never looking at.
 */
function changedPaths(keep = () => true) {
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
    .filter(keep)
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
 *
 * ── WHY THE RECEIPTS ARE READ FIRST ──────────────────────────────────────────
 *
 * This used to open with the three git calls and then filter the receipts with
 * the scope they produced. Profiled against the real worktree on a source path:
 * 707ms total, of which ~466ms was those three processes (merge-base 133ms,
 * rev-list 239ms, rev-parse 94ms) building a set of commit SHAs used to filter
 * a receipts list that was EMPTY — there is no receipts file in this tree at
 * all. Five git processes on every single Edit, three of them answering a
 * question nothing had asked.
 *
 * The scope is only ever used to reject a candidate, so establishing that there
 * are no candidates settles it. That costs one file read, and it is the common
 * case. The ordering below preserves the verdict exactly — no candidate is
 * false, an unscopable candidate (no `head`, or no merge-base) still counts —
 * it only stops paying for the answer before knowing whether the question
 * matters.
 */
function hasRedReceipt(branch) {
  const candidates = receipts().filter(
    (r) => r && r.branch === branch && typeof r.exitCode === "number" && r.exitCode !== 0,
  );
  if (candidates.length === 0) return false;

  // A receipt that records no HEAD cannot be scoped, and the rule is to accept
  // it rather than invent a reason to refuse.
  if (candidates.some((r) => !r.head)) return true;

  const base = git(["merge-base", "main", "HEAD"]);
  if (!base) return true; // scoping dropped, as above

  const heads = git(["rev-list", `${base}..HEAD`]);
  const scope = new Set(heads ? heads.split(/\r?\n/).filter(Boolean) : []);
  // `base..HEAD` includes HEAD, but not when HEAD *is* the base — which is the
  // case on a branch with nothing new on it yet, and exactly when today's RED
  // receipt was written. Hence the explicit add.
  const head = git(["rev-parse", "HEAD"]);
  if (head) scope.add(head);
  return candidates.some((r) => scope.has(r.head));
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
//
// Exported because tests/hooks/pre-edit.test.mjs kept its own copy of this
// list as a literal, which is the drift class this codebase keeps hitting:
// two lists that are the same until the day one of them is edited, and the
// suite then certifies a rule that is no longer the rule.
export const SECURITY_SURFACES = new Set([
  "apps/web/src/proxy.ts",
  "apps/web/src/lib/authz.ts",
  "apps/web/src/lib/gates.ts",
  "apps/web/src/lib/rate-limit.ts",
  "apps/web/src/lib/request-ip.ts",
]);

const isSecuritySurface = (rel) => {
  const key = pathKey(rel);
  return SECURITY_SURFACES.has(key) || /^packages\/db\/src\/schema\//.test(key);
};

/** The two behaviour tiers. Governance and integration do not qualify here. */
const isBehaviourTestPath = (rel) => {
  const key = pathKey(rel);
  return /^tests\/behaviour\//.test(key) || /^apps\/web\/tests\/behaviour\//.test(key);
};

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

  // ── THE GATE FILES ─────────────────────────────────────────────────────────
  //
  // Placed AFTER the branch rule on purpose. Both apply to a gate file edited
  // on `main`, and allowIfOverridden exits on the first hatch it sees, so
  // whichever rule is checked first is the one that gets to speak. On `main`
  // the useful thing to say is still "take a worktree" — that is the advice
  // that makes the change reviewable, and reviewability is the whole point of
  // refusing here at all.
  //
  // ── WHY THIS ONE HAS A HATCH AND .env DOES NOT ─────────────────────────────
  //
  // A hard refusal cannot be right, and this branch is the proof: it is itself
  // a rewrite of these files, so an absolute rule would have forbidden its own
  // authorship. More generally the layer has to stay maintainable — reviewable,
  // correctable, and switch-off-able when it is wrong — because a gate that
  // cannot be maintained does not get respected, it gets deleted wholesale, and
  // everything it defended goes with it.
  //
  // So the rule is not "you may not". It is "you may not do this silently". The
  // hatch is honoured, the line lands in workspace/gate-overrides.log, and that
  // line is what a reviewer greps for. The asymmetry with .env is the cost of
  // being wrong: a leaked secret cannot be un-leaked, while a gate edit is
  // visible in the diff of the very PR that carries it.
  if (isGateFile(rel)) {
    allowIfOverridden("", "gate-file");
    deny(
      `[pre-edit] Refusing to edit ${rel}: it is part of the enforcement layer itself.\n` +
        "Rule: the gates do not change as a side effect of doing something else. The six\n" +
        "hooks this layer replaces enforced nothing for the life of the project and no\n" +
        "session ever said so — an unannounced edit here puts it straight back in that\n" +
        "state, and the next thing anyone knows is that every gate happened to pass.\n" +
        "Why this is overridable when .env is not: the layer has to stay editable, and\n" +
        "this branch is itself a rewrite of these files. A gate that cannot be maintained\n" +
        "gets deleted wholesale rather than respected. The requirement is not that you\n" +
        "do not change it — it is that you do not change it silently.\n" +
        "Way forward: if changing the gate IS the work, say so and take the hatch. The\n" +
        "line lands in workspace/gate-overrides.log and belongs in the PR body.\n" +
        `${HATCH}`,
    );
  }

  if (!isSourcePath(rel) || isTestish(rel)) allow();

  // The common case — a developer with a test file open — settles in the first
  // check, which is the one `git status` this hook cannot avoid. The two
  // conditions after it are now a stat and a file read; the three git calls
  // that used to sit behind hasRedReceipt() are gone from the common path.
  const guarded = isSecuritySurface(rel);
  const touched = changedPaths(isTestPath);
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

/**
 * True when this file was RUN as the hook, false when it was imported.
 *
 * The suite needs SECURITY_SURFACES and used to keep a second copy of the list,
 * so this module has to be importable without running the gate and calling
 * process.exit inside the test runner.
 *
 * The comparison is biased on purpose, and the bias is the whole point. Being
 * wrong towards "imported" means the hook is spawned by Claude Code, decides it
 * is a library, enforces nothing and says nothing — silent, and precisely the
 * state the six hooks this replaces were in. Being wrong towards "hook" means a
 * test process exits early, which is loud and immediate. So every case that
 * cannot be answered resolves to "this is a real invocation", and the 50-odd
 * spawn tests in the suite are what prove the answer is right in practice.
 */
function invokedAsHook() {
  const entry = process.argv[1];
  if (!entry) return false; // --eval, the REPL, a worker thread: no script ran
  let self;
  try {
    self = fileURLToPath(import.meta.url);
  } catch {
    return true;
  }
  if (resolve(entry) === resolve(self)) return true;
  try {
    // A symlinked, 8.3-shortened or differently-cased invocation path still
    // names this file. import.meta.url is already real-pathed by the loader,
    // so resolving both the same way is what makes them comparable on Windows.
    return realpathSync.native(entry) === realpathSync.native(self);
  } catch {
    return true; // cannot tell — behave as the gate
  }
}

// ── N4: THIS GATE FAILED OPEN, AND THE CATCH IS WHAT MADE IT ────────────────
//
// What stood here caught every internal error, wrote one line to stderr and
// called allow(). The comment above it argued that an uncaught throw "does not
// block anything", so catching it only made the failure legible.
//
// That premise was wrong, and it is wrong in the direction that matters. This
// hook is registered as
//
//     node "$CLAUDE_PROJECT_DIR"/.claude/hooks/pre-edit.mjs || exit 2
//
// so the SHELL turns any non-zero exit into 2. Measured, with a fault injected
// into currentBranch(): the registered command line exits 2 with the catch
// removed and exits 0 with it present. The catch was not making a
// non-blocking failure legible — it was converting a blocking failure into a
// silent allow, which meant that on any throw the .env rule, the drizzle
// snapshot rule, no-edits-on-main, the gate-file rule and test-first were all
// off at once and nothing said so.
//
// pre-bash.mjs reached the opposite conclusion in the same round (I4) and this
// file kept the old behaviour, so the two halves of the same layer disagreed
// about whether a broken gate is an open one. They agree now: an internal error
// REFUSES, is recorded in workspace/gate-errors.log with the rest, and names
// itself in the refusal so it is diagnosable without reading the log. The
// override still works, so a bug here cannot brick a session — at the usual
// price of a reason written down.
if (invokedAsHook()) {
  try {
    main();
  } catch (err) {
    appendWorkspace(
      "gate-errors.log",
      `${new Date().toISOString()}\tpre-edit\t${err?.stack?.split("\n")[0] ?? err}`,
    );
    allowIfOverridden("", "gate-internal-error");
    deny(
      `[pre-edit] Refused — the gate itself failed, so it could not judge this edit.\n` +
        `  ${err?.stack?.split("\n")[0] ?? err}\n` +
        `Recorded in workspace/gate-errors.log. This refuses rather than allowing ` +
        `because every rule in this file is off while it is broken, and a gate that ` +
        `is off without saying so is the defect this layer exists to remove.\n` +
        `Way forward: fix the hook — or, if you need to move now, say why:\n` +
        `  GML_GATE_SKIP='<why>'`,
    );
  }
}
