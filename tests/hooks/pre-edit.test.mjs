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

// The hook's own constant, imported rather than copied — see the note above
// SURFACES. Importing it is only possible because pre-edit.mjs runs its main()
// behind an "was I invoked as the hook, or imported?" check; that check is
// biased towards running, so if it is ever wrong the 50-odd spawn tests below
// fail loudly rather than the gate going quiet.
import { GATE_SETTINGS, SECURITY_SURFACES } from "../../.claude/hooks/pre-edit.mjs";

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

// ── C6: PROTECTED ON THE PLATFORM THIS PROJECT ACTUALLY RUNS ON ──────────────
//
// isEnvFile matched the literal basename with a case-SENSITIVE regex. On
// Windows — this project's only platform — that is not a filter, it is a
// spelling suggestion. Reproduced before the fix, in a sandbox holding a real
// `.env`: a Write to `.ENV` and to `.env::$DATA` was ALLOWED by the hook, and
// writing through either name replaced the contents of `.env` itself. The
// filesystem was asked directly — both names read the secret back out.

test("protected: .env is protected case-insensitively — Windows filesystems are", (t) => {
  const dir = fixture(t);
  for (const name of [".ENV", ".Env", ".eNv", ".ENV.LOCAL", ".Env.Production"]) {
    const r = runHook(dir, editOf(dir, name, "Write"));
    assert.equal(r.status, 2, `${name} names the same file as .env here; stderr=${r.stderr}`);
  }
});

test("protected: an NTFS alternate data stream is not a way round", (t) => {
  const dir = fixture(t);
  // `.env::$DATA` is NTFS syntax for the DEFAULT data stream of `.env` — the
  // same bytes, under a name the regex did not recognise. `.env:hidden` is a
  // named stream: different bytes, but still a write into the `.env` file
  // object, and still a place to park a secret. Both are writes to a protected
  // file, so both are refused.
  for (const name of [".env::$DATA", ".ENV::$DATA", ".env:hidden", ".env.local::$DATA"]) {
    const r = runHook(dir, editOf(dir, name, "Write"));
    assert.equal(r.status, 2, `${name} reaches .env; stderr=${r.stderr}`);
  }
});

test("protected: .env.EXAMPLE is the committed example and stays editable", (t) => {
  const dir = fixture(t);
  // The other direction of the same bug, and the more corrosive one: the
  // refusal above tells you to go and edit `.env.example`, while the
  // case-sensitive `name !== ".env.example"` turned that very file — spelled
  // the way Windows will happily open it — into a second refusal.
  for (const name of [".env.example", ".env.EXAMPLE", ".ENV.EXAMPLE", ".Env.Example"]) {
    const r = runHook(dir, editOf(dir, name, "Write"));
    assert.equal(r.status, 0, `${name} IS .env.example here; stderr=${r.stderr}`);
  }
});

test("protected: `.env.` and `.env ` are different files, so they are not bypasses", (t) => {
  // CHARACTERISATION, not a regression test — this was already correct and was
  // green before the C6 fix and after it. It is here to pin the BOUNDARY of
  // that fix. "Win32 strips a trailing dot or space" is true of the Win32 API
  // and NOT true of Node, which prefixes `\\?\` and gets a literal, distinct
  // name. The assertion below asks the filesystem rather than believing either
  // story: these names do not resolve to `.env`, so refusing them would be
  // theatre — a rule that looks like protection and defends nothing.
  const dir = fixture(t);
  writeFileSync(join(dir, ".env"), "SUPABASE_SERVICE_ROLE_KEY=real\n");
  for (const name of [".env.", ".env "]) {
    assert.throws(
      () => readFileSync(join(dir, name), "utf8"),
      /ENOENT/,
      `${name} must not resolve to .env, or this test is asserting the wrong thing`,
    );
    const r = runHook(dir, editOf(dir, name, "Write"));
    assert.equal(r.status, 0, `${name} is a different file; stderr=${r.stderr}`);
  }
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
  // `apps/web/src/lib/wiki.spec.ts` was on this list and has been removed.
  // It was asserting the defect below: `.spec.` is not a test convention in
  // this repository (144 files match `.test.`, ZERO match `.spec.`, and no
  // script in package.json globs for it), so accepting it only widened the way
  // past the nudge. The shapes below are the ones that actually exist.
  for (const rel of [
    "apps/web/src/lib/wiki.test.ts",
    "apps/web/src/lib/wiki.test.tsx",
    "apps/web/src/lib/wiki.d.ts",
    "tests/behaviour/wiki.test.ts",
    "tests/governance/test_200_wiki.test.mjs",
    "apps/web/tests/behaviour/proxy.test.ts",
    "packages/db/tests/queue.test.ts",
  ]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 0, `${rel} must be writable with no evidence; stderr=${r.stderr}`);
  }
});

// ── WHAT COUNTS AS "THIS FILE IS A TEST" ─────────────────────────────────────
//
// isTestish was `/(^|\/)tests\//` on the path OR `/\.(test|spec)\./` on the
// name, and both are wider than they read. Measured against this tree: 144
// files match `.test.`, ZERO match `.spec.`, and the ONLY directory named
// `tests/` anywhere in the repository is the top-level one. So the extra width
// buys nothing that exists and sells the rule — reproduced before the fix, all
// three of these were ALLOWED with no test evidence whatsoever.

test("tdd: `.spec.` is not a test convention in this repository", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, "apps/web/src/lib/x.spec.ts", "Write"));
  assert.equal(r.status, 2, `no .spec. file exists here and no runner globs for one; stderr=${r.stderr}`);
});

test("tdd: `.test.` in the middle of a name does not make a test", (t) => {
  const dir = fixture(t);
  for (const rel of ["apps/web/src/lib/thing.test.helper.ts", "apps/web/src/lib/x.test.data.json"]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 2, `${rel} is a helper beside a test, not a test; stderr=${r.stderr}`);
  }
});

test("tdd: a tests/ directory inside src/ is not a test tier", (t) => {
  const dir = fixture(t);
  for (const rel of ["apps/web/src/tests/helpers.ts", "packages/db/src/tests/seed.ts"]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 2, `${rel} is source; `+`stderr=${r.stderr}`);
  }
});

test("tdd: a file under src/tests/ is not evidence that a test was touched", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  // The same looseness read from the other side: isTestPath shares the regex,
  // so `mkdir apps/web/src/tests && touch anything` unlocked the nudge for the
  // whole tree. Both predicates now go through one tier-root rule so they
  // cannot drift apart — this codebase's recurring failure.
  put(dir, "apps/web/src/tests/helpers.ts");
  const r = runHook(dir, editOf(dir, SOURCE));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
});

test("tdd: a shouted source path does not walk past the nudge", (t) => {
  const dir = fixture(t);
  put(dir, SOURCE);
  // Found while fixing C6 and the same defect: isSourcePath is case-sensitive,
  // so on this project's platform `APPS/WEB/SRC/LIB/WIKI.TS` was ALLOWED while
  // naming the very file that had just been refused. Verified by reading the
  // file back through the shouted name — same bytes.
  for (const rel of ["APPS/WEB/SRC/LIB/WIKI.TS", "Apps/Web/Src/Lib/wiki.ts", "apps/web/SRC/lib/wiki.ts"]) {
    const r = runHook(dir, editOf(dir, rel));
    assert.equal(r.status, 2, `${rel} IS ${SOURCE} on this filesystem; stderr=${r.stderr}`);
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

// IMPORTED from the hook, not restated here. This was a second copy of the
// hook's own list — the drift class this codebase keeps paying for: two lists
// that agree until someone adds a surface to one of them, after which the suite
// goes on certifying a rule that is no longer the rule, in green. A copy also
// cannot notice the hook's list SHRINKING, which is the direction that matters.
const SURFACES = [
  ...SECURITY_SURFACES,
  // Deliberately not in the exported set: everything under
  // packages/db/src/schema/ is a surface by PATTERN rather than by name, and
  // this entry is what holds that half of the rule to account.
  "packages/db/src/schema/gates.ts",
];

test("security: the surface list under test is the hook's own", () => {
  assert.ok(SECURITY_SURFACES instanceof Set, "the hook must export the list it actually uses");
  assert.ok(SECURITY_SURFACES.size >= 5, `only ${SECURITY_SURFACES.size} named surfaces — did the list shrink?`);
  assert.ok(SECURITY_SURFACES.has("apps/web/src/proxy.ts"), "proxy.ts is the request gate; it cannot quietly leave");
});

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
  for (const rel of SURFACES) {
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

test("security: a shouted security surface is still a security surface", (t) => {
  const dir = fixture(t);
  put(dir, "apps/web/src/lib/authz.ts");
  put(dir, "tests/governance/test_042_authz.test.mjs");
  // Before the fix this was ALLOWED: the surface list is compared exactly, and
  // on a case-insensitive filesystem the shift key was enough to drop out of
  // the narrowed rule AND out of isSourcePath, clearing the nudge entirely.
  const r = runHook(dir, editOf(dir, "APPS/WEB/SRC/LIB/AUTHZ.TS"));
  assert.equal(r.status, 2, `expected a block; stderr=${r.stderr}`);
  assert.match(r.stderr, /tests\/behaviour\//, "and for the right reason");
});

// ── I9. THE GATE FILES THEMSELVES ────────────────────────────────────────────
//
// Reproduced before the fix: a Write to `.claude/hooks/pre-bash.mjs`, to
// `.claude/hooks/_lib.mjs` and to `.claude/settings.json` was ALLOWED. One edit
// turns the whole layer off, and nothing anywhere says a word — which is
// precisely how the six hooks this replaces stayed dead for the life of the
// project.
//
// ── WHY THE REFUSAL IS OVERRIDABLE AND NOT ABSOLUTE ──────────────────────────
//
// A hard refusal cannot be right here, and the proof is this branch: the layer
// has to stay deliberately editable or it cannot be maintained, reviewed or
// switched off when it is wrong — and a gate that cannot be maintained is a
// gate that gets deleted wholesale, taking everything it defended with it. So
// the rule is not "you may not"; it is "you may not do this silently". The
// hatch is honoured and LOGGED, and the log line is what a reviewer looks for.

// The settings half comes from the hook; the hooks half is a list of INSTANCES
// the hook matches by pattern, which is a different thing from a copied literal
// — it is the pattern being held to account on named files.
const GATE_FILES = [
  ...GATE_SETTINGS,
  ".claude/hooks/pre-edit.mjs",
  ".claude/hooks/pre-bash.mjs",
  ".claude/hooks/post-edit.mjs",
  ".claude/hooks/post-bash.mjs",
  ".claude/hooks/session-start.mjs",
  ".claude/hooks/stop.mjs",
  ".claude/hooks/_lib.mjs",
];

test("gate: the protected settings list is the hook's own, and has not shrunk", () => {
  // Importing a list closes the drift where a COPY goes stale, and opens a
  // different one: a test that iterates the imported list cannot notice the
  // list getting SHORTER, because its own loop gets shorter with it. Verified
  // by mutation — deleting settings.local.json from the hook left all 57 tests
  // green until these two assertions existed. So the membership that matters is
  // named here explicitly, which is the only form that can fail on a removal.
  assert.ok(GATE_SETTINGS.has(".claude/settings.json"), "the file that wires every hook");
  assert.ok(
    GATE_SETTINGS.has(".claude/settings.local.json"),
    "local settings wire hooks too, and are the quietest place to switch them off",
  );
});

test("gate: editing a hook, or the settings that wire them, is refused", (t) => {
  for (const rel of GATE_FILES) {
    const dir = fixture(t);
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 2, `${rel} switches enforcement off; stderr=${r.stderr}`);
    assert.match(r.stderr, /GML_GATE_SKIP/, "must hand over the deliberate way through");
  }
});

test("gate: the bootstrap hatch is honoured and LOGGED", (t) => {
  const dir = fixture(t);
  const r = runHook(dir, editOf(dir, ".claude/settings.json", "Write"), {
    GML_GATE_SKIP: "chore/enforcement: this branch rewrites the gate layer",
  });
  assert.equal(r.status, 0, `the layer must stay maintainable; stderr=${r.stderr}`);
  const log = readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8");
  assert.match(log, /gate-file/, "the rule overridden is named, so the log can be grepped");
  assert.match(log, /rewrites the gate layer/, "and the reason, for the PR to quote");
});

test("gate: a touched test does not license switching the gate off", (t) => {
  const dir = fixture(t);
  put(dir, "tests/behaviour/gate.test.ts");
  const r = runHook(dir, editOf(dir, ".claude/hooks/pre-bash.mjs", "Write"));
  assert.equal(r.status, 2, "test evidence answers the test-first rule, not this one");
});

test("gate: a shouted or stream-suffixed .claude path is the same file", (t) => {
  const dir = fixture(t);
  for (const rel of [".CLAUDE/HOOKS/PRE-BASH.MJS", ".claude/Hooks/Pre-Edit.mjs", ".claude/hooks/_lib.mjs::$DATA"]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 2, `${rel} reaches the gate; stderr=${r.stderr}`);
  }
});

test("gate: documentation ABOUT the gates is not itself a gate", (t) => {
  const dir = fixture(t);
  // These enforce nothing, so gating them would only teach people that the
  // rule is noise. The protected set is the executable surface: the hooks and
  // the settings that wire them.
  for (const rel of [".claude/hooks/README.md", ".claude/agents/reviewer.md", "docs/superpowers/README.md"]) {
    const r = runHook(dir, editOf(dir, rel, "Write"));
    assert.equal(r.status, 0, `${rel} enforces nothing; stderr=${r.stderr}`);
  }
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

// ── FAST ENOUGH TO SIT ON EVERY EDIT ─────────────────────────────────────────
//
// The assertion that stood here was `elapsed < 3000` on a single run. It passed
// at 908ms and would have passed at 2.9s, so it could not fail and therefore
// meant nothing — the same shape as the 28 assertions this project wrote to
// match what the code already did.
//
// What the profile actually found, measured on a source path in the real
// worktree: 707ms median, of which ~466ms was hasRedReceipt() spending THREE
// git processes (merge-base, then rev-list at 239ms, then rev-parse) building a
// set of commit SHAs it used to filter a receipts list that was EMPTY. Five git
// processes on every Edit; the answer needed two.

/**
 * Give the fixture a real commit and a real `main`, without running `git commit`.
 *
 * Every other test here runs on an unborn branch, and that HIDES the cost this
 * section is about: hasRedReceipt() only reaches its three scoping git calls
 * once `git merge-base main HEAD` can answer, which needs both refs to exist.
 * On an unborn branch that call fails, the scoping is skipped, and the hook
 * looks 480ms cheaper than it is in the repository it actually runs in. Built
 * with plumbing — write-tree, commit-tree, update-ref — so this suite still
 * never commits.
 */
function withHistory(dir, branch = "chore/thing") {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  const commit = run(["commit-tree", run(["write-tree"]), "-m", "base"]);
  for (const ref of ["refs/heads/main", `refs/heads/${branch}`]) run(["update-ref", ref, commit]);
  return commit;
}

test("fast: an edit costs at most two git processes", (t) => {
  // A wall-clock budget cannot say WHICH work went away, and it drifts with
  // whatever else the machine is doing. GIT_TRACE names every git process the
  // hook starts, so this counts the actual work and reads the same on a loaded
  // CI box as on an idle laptop.
  const dir = fixture(t);
  withHistory(dir);
  put(dir, SOURCE);
  const trace = join(dir, "git-trace.log");
  const r = runHook(dir, editOf(dir, SOURCE), { GIT_TRACE: trace });
  assert.equal(r.status, 2, `expected the ordinary refusal; stderr=${r.stderr}`);
  const calls = readFileSync(trace, "utf8")
    .split(/\r?\n/)
    .map((l) => /built-in: git (.*)$/.exec(l)?.[1])
    .filter(Boolean);
  assert.ok(
    calls.length <= 2,
    `${calls.length} git processes on ONE edit: ${calls.join(" | ")}\n` +
      "The budget is the branch and one status. A third means a rule started " +
      "asking git a question it could have answered from a file it already read.",
  );
});

test("fast: a gated edit costs little more than an ungated one", (t) => {
  // Modelled on tests/hooks/pre-bash.test.mjs "10. the common case costs
  // nothing worth noticing" — the budget covers the WHOLE spawn, node's own
  // start-up included, because that is what the developer waits for — but it is
  // stated as a RATIO against this same hook on a cheaper path, measured on this
  // machine seconds earlier, rather than as a number of milliseconds.
  //
  // WHY NOT A MILLISECOND CONSTANT. Measured in this fixture: 706-885ms per
  // gated edit with the defect, 347-407ms once fixed — and 609ms once fixed
  // while other suites were running on the same laptop. A constant that
  // separates those is one busy CI box away from failing on correct code, and a
  // constant safe from that is too loose to fail on the defect at all. The
  // latter is an assertion that cannot fail, which is the shape this project
  // already has 28 of.
  //
  // WHY THIS RATIO AND NOT A SUBTRACTION. The first version of this test priced
  // one git call as (docs - .env) and budgeted three of them. Measured over five
  // repetitions that statistic ran 1.71-3.15 on FIXED code against 4.78-6.76 on
  // the defect: the difference of two small, noisy numbers ends up in the
  // denominator, and a budget of 3 failed on correct code once in five runs. The
  // plain ratio below measured 1.32-1.84 fixed against 2.65-3.44 defective —
  // both terms are large, both move together when the machine is busy, so 2.25
  // sits between the two distributions with room on each side.
  //
  // What the ratio means: `docs/*` makes one git call (the branch), a gated
  // `src/*` path makes two (the branch, plus one `git status`) and used to make
  // five. Counts verified with GIT_TRACE in the test above, which is the
  // instrument that actually pins the fix; this one is the wall-clock backstop.
  const dir = fixture(t);
  withHistory(dir);
  put(dir, SOURCE);
  put(dir, "docs/architecture.md");

  const price = (payload) => {
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const started = Date.now();
      runHook(dir, payload);
      runs.push(Date.now() - started);
    }
    // Second-cheapest rather than the mean: one scheduler stall must not be able
    // to decide the verdict in either direction.
    return runs.sort((a, b) => a - b)[1];
  };

  runHook(dir, editOf(dir, SOURCE)); // warm; git's first run in a tree is not the steady state
  const ungated = price(editOf(dir, "docs/architecture.md", "Write"));
  const gated = price(editOf(dir, SOURCE));

  assert.ok(
    gated <= 2.25 * ungated,
    `a gated edit costs ${gated}ms against ${ungated}ms for an ungated one — ` +
      `${(gated / ungated).toFixed(2)}x, budget 2.25x. This runs on EVERY Edit and Write.`,
  );
  // The one thing a ratio cannot catch: work that is slow without being git.
  assert.ok(gated < 2500, `${gated}ms per gated edit — a rule in here is doing real work`);
});
