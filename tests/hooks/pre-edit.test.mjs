// Spawn tests for .claude/hooks/pre-edit.mjs — the PreToolUse Edit|Write|MultiEdit gate.
//
// ── WHY THESE TESTS SPAWN THE HOOK ───────────────────────────────────────────
//
// The hooks this replaces were unit-tested by nobody and driven by a contract
// that does not exist: they read `$TOOL_INPUT` (zero occurrences in the Claude
// Code binary) and relied on `pathGlob` (also zero occurrences). Both mistakes
// are invisible to a test that imports a function and calls it — they only show
// up when the hook is run the way the harness runs it: a child process, payload
// as JSON on stdin, verdict as an exit code. So every test here spawns the real
// file and speaks the real protocol. Exit 2 = blocked, reason on stderr.
//
// ── WHY EACH TEST BUILDS ITS OWN GIT FIXTURE ─────────────────────────────────
//
// The hook resolves the repository from its OWN location (_lib.mjs:
// PROJECT_DIR = <hook dir>/../..), so copying the two files into a temp
// directory makes that temp directory the "repository" the hook polices. That
// gives each test a branch name, a working tree and a receipts file it fully
// controls, and it means this suite can never touch the real repository's git
// state — no commits, no staging, no stash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOK_SRC = resolve(ROOT, ".claude", "hooks", "pre-edit.mjs");
const LIB_SRC = resolve(ROOT, ".claude", "hooks", "_lib.mjs");

/**
 * A throwaway repository with the hook installed inside it.
 *
 * No commit is ever made: `git status --porcelain` and `git branch
 * --show-current` both work on an unborn branch, which is all the hook needs
 * for the conditions under test.
 */
function fixture(t, { branch = "chore/thing" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gml-pre-edit-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  copyFileSync(LIB_SRC, join(dir, ".claude", "hooks", "_lib.mjs"));
  copyFileSync(HOOK_SRC, join(dir, ".claude", "hooks", "pre-edit.mjs"));
  execFileSync("git", ["init", "-q", "-b", branch, "."], { cwd: dir, stdio: "ignore" });
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leaked temp directory must not fail a test run.
    }
  });
  return dir;
}

/** Write a file inside the fixture, creating parents. Returns its absolute path. */
function put(dir, rel, body = "x\n") {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

/** Drive the hook exactly as Claude Code does: JSON on stdin, verdict as exit code. */
function runHook(dir, payload, env = {}) {
  return spawnSync(process.execPath, [join(dir, ".claude", "hooks", "pre-edit.mjs")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      // Cleared deliberately: an override leaking in from the developer's own
      // shell would silently turn every assertion below green.
      GML_GATE_SKIP: "",
      ...env,
    },
  });
}

/** The PreToolUse payload for an edit of `rel` inside the fixture. */
function editOf(dir, rel, tool = "Edit") {
  return {
    session_id: "test",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: join(dir, ...rel.split("/")) },
    cwd: dir,
  };
}

// ── 1. PROTECTED FILES ───────────────────────────────────────────────────────
// Secrets and generated drizzle snapshots are never edited by hand, and this
// refusal has no escape hatch: an override that can unlock a .env is an
// override that will be used to unlock a .env.

test("protected: writing .env is refused", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, ".env", "Write"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
  assert.match(r.stderr, /\.env/);
  assert.match(r.stderr, /\.env\.example/, "must name the way forward");
});

test("protected: writing .env.local is refused", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, ".env.local", "Write"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("protected: .env.example is editable", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, ".env.example", "Write"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("protected: hand-editing a drizzle snapshot is refused", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, "packages/db/src/migrations/meta/0007_snapshot.json"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
  assert.match(r.stderr, /journal/i, "must say why: the journal desynchronises");
  assert.match(r.stderr, /generate/i, "must name the way forward");
});

test("protected: the override cannot unlock a protected file", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, ".env", "Write"), { GML_GATE_SKIP: "I know what I am doing" });
  assert.equal(r.status, 2, "protected files are not overridable");
});

// ── 2. NO EDITS ON main / master ─────────────────────────────────────────────
// 27 commits of this project's history were made straight onto the integration
// branch. The refusal has to hand over the exact worktree command, because a
// gate that says "use a branch" and leaves the developer to remember how is a
// gate that gets overridden out of impatience.

test("main: editing a repository file on main is refused and names the worktree command", (t) => {
  const dir = fixture(t, { branch: "main" });
  const r = runHook(dir, editOf(dir, "README.md"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
  assert.match(r.stderr, /main/);
  assert.match(r.stderr, /git worktree add/, "must hand over the way forward verbatim");
});

test("main: master is treated the same as main", (t) => {
  const dir = fixture(t, { branch: "master" });
  const r = runHook(dir, editOf(dir, "apps/web/src/lib/authz.ts"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("main: workspace/ scratch stays writable on main", (t) => {
  const dir = fixture(t, { branch: "main" });
  const r = runHook(dir, editOf(dir, "workspace/session_log.md", "Write"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("main: the same edit is fine on a feature branch", (t) => {
  const dir = fixture(t, { branch: "chore/enforcement" });
  const r = runHook(dir, editOf(dir, "README.md"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("main: an explicit override is honoured and recorded", (t) => {
  const dir = fixture(t, { branch: "main" });
  const r = runHook(dir, editOf(dir, "README.md"), { GML_GATE_SKIP: "hotfix: prod is down" });
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  const log = readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8");
  assert.match(log, /hotfix: prod is down/, "every use of the hatch is logged for the PR");
});

// ── 3. TEST-FIRST NUDGE ──────────────────────────────────────────────────────
// Not one test in this project's history was written before the code it tests;
// every one shipped in the same commit, and at least 28 assertions ended up
// pinning a defect in place because the test was written to match what the code
// already did. The gate cannot prove a test came first — it can only refuse to
// let source change while there is no sign of one, and say plainly that that is
// what it is doing.

/** Write a receipt line the way scripts/test-gate.mjs does. */
function receipt(dir, { branch = "chore/thing", exitCode = 1, head = "" } = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    branch,
    head,
    treeHash: "0".repeat(64),
    suites: [{ suite: "behaviour", ran: true, status: exitCode ? "fail" : "pass" }],
    exitCode,
    noDb: false,
  });
  put(dir, "workspace/test-receipts.jsonl", `${line}\n`);
}

const SOURCE = "apps/web/src/lib/wiki.ts";

test("tdd: source edit with no sign of a test is refused, citing the Iron Law", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
  assert.match(r.stderr, /iron law/i, "must name the rule");
  assert.match(r.stderr, /tests\//, "way forward 1: touch a test");
  assert.match(r.stderr, /receipt/i, "way forward 2: a RED receipt");
  assert.match(r.stderr, /tdd-exempt\.json/, "way forward 3: a time-boxed exemption");
  assert.match(r.stderr, /nudge|cannot prove|not proof/i, "must admit it is a nudge, not proof");
});

test("tdd: a modified-or-untracked file under tests/ is enough", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  put(dir, "tests/governance/test_200_wiki.test.mjs");
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("tdd: a RED receipt on this branch is enough", (t) => {
  const dir = fixture(t, { branch: "feat/wiki" });
  put(dir, SOURCE);
  receipt(dir, { branch: "feat/wiki", exitCode: 1 });
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("tdd: an all-green receipt is NOT red evidence", (t) => {
  const dir = fixture(t, { branch: "feat/wiki" });
  put(dir, SOURCE);
  receipt(dir, { branch: "feat/wiki", exitCode: 0 });
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, "a passing run proves nothing about a test that came first");
});

test("tdd: a RED receipt from another branch does not carry over", (t) => {
  const dir = fixture(t, { branch: "feat/wiki" });
  put(dir, SOURCE);
  receipt(dir, { branch: "feat/something-else", exitCode: 1 });
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("tdd: an unexpired tdd-exempt.json is enough", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  put(
    dir,
    "workspace/tdd-exempt.json",
    JSON.stringify({ reason: "spike: measuring ffmpeg throughput", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
  );
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("tdd: an expired exemption is ignored", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  put(
    dir,
    "workspace/tdd-exempt.json",
    JSON.stringify({ reason: "spike", expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  );
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("tdd: an exemption longer than the 60-minute cap is ignored", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  put(
    dir,
    "workspace/tdd-exempt.json",
    JSON.stringify({ reason: "all week please", expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() }),
  );
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, "the cap is the point: an open-ended exemption is no exemption");
});

test("tdd: the gate does not stand between you and writing the test", (t) => {
  const dir = fixture(t);
  for (const rel of [
    "apps/web/src/lib/wiki.test.ts",
    "apps/web/src/lib/wiki.spec.ts",
    "apps/web/src/lib/wiki.d.ts",
    "tests/behaviour/wiki.test.ts",
  ]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 0, `${rel} must be writable with no evidence; stderr=${r.stderr}`);
  }
});

test("tdd: files outside apps/*/src and packages/*/src are not gated", (t) => {
  const dir = fixture(t);
  for (const rel of ["scripts/backup.sh", "docs/architecture.md", "specs/111-x/spec.md"]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 0, `${rel} must not need test evidence; stderr=${r.stderr}`);
  }
});

test("tdd: packages/*/src is gated too", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, "packages/shared/src/zod/forms.ts"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("tdd: an explicit override is honoured and recorded", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  const r = runHook(dir, editOf(dir, SOURCE), { GML_GATE_SKIP: "reverting a bad merge" });
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  const log = readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8");
  assert.match(log, /reverting a bad merge/);
});

// ── 4. SECURITY SURFACES NEED A BEHAVIOUR TEST ───────────────────────────────
// tests/governance/ regex-matches source text. It was green for months while
// the application returned HTTP 500 on its own login page, because a regex can
// see that a file mentions `requireRole` and cannot see whether the role is
// ever enforced. On the files where being wrong means an unauthorised read,
// only tests/behaviour/ — real code, real Postgres — counts as touching a test.

const SECURITY_SURFACES = [
  "apps/web/src/proxy.ts",
  "apps/web/src/lib/authz.ts",
  "apps/web/src/lib/gates.ts",
  "apps/web/src/lib/rate-limit.ts",
  "apps/web/src/lib/request-ip.ts",
  "packages/db/src/schema/gates.ts",
];

test("security: a governance test does not license an authz change", (t) => {
  const dir = fixture(t);
  put(dir, "apps/web/src/lib/authz.ts");
  put(dir, "tests/governance/test_042_authz.test.mjs");
  const r = runHook(dir, editOf(dir, "apps/web/src/lib/authz.ts"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
  assert.match(r.stderr, /governance/i, "must name what was rejected");
  assert.match(r.stderr, /tests\/behaviour\//, "must name what is required instead");
  assert.match(
    r.stderr,
    /regex|source text|cannot observe|runtime/i,
    "must explain WHY governance cannot stand in for behaviour",
  );
});

test("security: every listed surface rejects a governance-only test", (t) => {
  for (const rel of SECURITY_SURFACES) {
    const dir = fixture(t);
    put(dir, rel);
    put(dir, "tests/governance/test_042_thing.test.mjs");
    const r = runHook(dir, editOf(dir, rel));
    assert.equal(r.status, 2, `${rel} must demand a behaviour test; stderr=${r.stderr}`);
  }
});

test("security: a behaviour test under tests/behaviour/ satisfies it", (t) => {
  const dir = fixture(t);
  put(dir, "apps/web/src/lib/authz.ts");
  put(dir, "tests/behaviour/authz.test.ts");
  const r = runHook(dir, editOf(dir, "apps/web/src/lib/authz.ts"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("security: apps/web/tests/behaviour/ counts as well", (t) => {
  const dir = fixture(t);
  put(dir, "apps/web/src/proxy.ts");
  put(dir, "apps/web/tests/behaviour/proxy.test.ts");
  const r = runHook(dir, editOf(dir, "apps/web/src/proxy.ts"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("security: anything under packages/db/src/schema/ is a surface", (t) => {
  const dir = fixture(t);
  put(dir, "packages/db/src/schema/learners.ts");
  put(dir, "tests/behaviour/learners.test.ts");
  const r = runHook(dir, editOf(dir, "packages/db/src/schema/learners.ts"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("security: only condition (a) narrows — a RED receipt still counts", (t) => {
  const dir = fixture(t, { branch: "feat/authz" });
  put(dir, "apps/web/src/lib/authz.ts");
  receipt(dir, { branch: "feat/authz", exitCode: 1 });
  const r = runHook(dir, editOf(dir, "apps/web/src/lib/authz.ts"));
  assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
});

test("tdd: a test that has been DELETED is not evidence that a test exists", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  // Stage a test, then delete it from the working tree: `git status` still
  // reports the path, which is exactly the loophole — "I touched a test" must
  // mean a test is THERE, not that one used to be.
  put(dir, "tests/behaviour/wiki.test.ts");
  execFileSync("git", ["add", "tests/behaviour/wiki.test.ts"], { cwd: dir, stdio: "ignore" });
  rmSync(join(dir, "tests", "behaviour", "wiki.test.ts"));
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("security: a neighbouring lib file is NOT a surface", (t) => {
  const dir = fixture(t);
  put(dir, "apps/web/src/lib/wiki.ts");
  put(dir, "tests/governance/test_042_wiki.test.mjs");
  const r = runHook(dir, editOf(dir, "apps/web/src/lib/wiki.ts"));
  assert.equal(r.status, 0, "the narrowed rule applies to the listed surfaces only");
});

// ── FAILING OPEN ─────────────────────────────────────────────────────────────
// A gate that blocks every edit because of its own bug is worse than no gate:
// it gets removed, and everything it was defending goes with it. Exit 2 is
// reserved for a decision the hook actually made; anything it cannot parse or
// cannot read passes through.

test("robust: malformed stdin does not block the edit", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, "}{ not json");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test("robust: empty stdin does not block the edit", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, "");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test("robust: a payload with no file_path does not block the edit", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test("robust: a tool this gate does not police passes through", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
  });
  assert.equal(r.status, 0, "only Edit|Write|MultiEdit carry a file_path this gate understands");
});

test("robust: MultiEdit is policed like Edit", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, ".env", "MultiEdit"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("robust: a relative file_path is resolved against the repository", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "apps/web/src/lib/wiki.ts" },
    cwd: dir,
  });
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("robust: a file outside this repository is none of this gate's business", (t) => {
  const dir = fixture(t, { branch: "main" });
  const outside = join(dir, "..", "somewhere-else.ts");
  const r = runHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: outside },
    cwd: dir,
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test("robust: a corrupt tdd-exempt.json neither crashes nor grants an exemption", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  put(dir, "workspace/tdd-exempt.json", "{ this is not json");
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected the ordinary refusal, not a crash; stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /internal error/i);
});

test("robust: a corrupt receipts file neither crashes nor counts as red", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  put(dir, "workspace/test-receipts.jsonl", "not json\n{\"half\": \n");
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected the ordinary refusal, not a crash; stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /internal error/i);
});

test("robust: the gate is fast enough to sit on every edit", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  const started = Date.now();
  runHook(dir, editOf(dir, SOURCE));
  const elapsed = Date.now() - started;
  // Generous because node's own start-up dominates: the budget exists to catch
  // a hook that grows a `pnpm test` or a network call, not to measure ms.
  assert.ok(elapsed < 3000, `hook took ${elapsed}ms — it runs on EVERY edit`);
});
