// SessionStart and Stop hooks — SPAWNED, the way Claude Code runs them.
//
// ── WHY SPAWN RATHER THAN IMPORT ─────────────────────────────────────────────
//
// The hooks this file covers replace two scripts that never enforced anything.
// The reason was not a logic bug inside them; it was the INTERFACE around them:
// the old PreToolUse hooks read a `$TOOL_INPUT` variable that does not exist in
// the Claude Code binary, and `scripts/stop_session.mjs` — which appends
// unconditionally, with no condition that could skip it — left
// workspace/session_log.md at 112 bytes, header only, across every session that
// produced 27 commits. It never ran.
//
// A unit test that imported a function and called it would have passed for all
// of that. So every test here starts a real `node <hook>` process, writes the
// hook payload to its STDIN as JSON, and asserts on the exit code, stdout and
// stderr — the three things Claude Code actually looks at. Exit 2 blocks.
//
// ── WHY EVERY TEST BUILDS A THROWAWAY REPOSITORY ─────────────────────────────
//
// _lib.mjs derives PROJECT_DIR from the hook file's OWN location
// (`resolve(HERE, "..", "..")`), so a copy of .claude/hooks/ under a temp
// directory roots the hook in that temp directory. That is what lets these
// tests control branch name, dirty files and receipts exactly, while the real
// repository is only ever READ (to copy the hook sources out of it).
//
// `git init` is the only git command run here. Nothing commits, pushes or
// stashes: the stash stack and index are shared with the main checkout and
// other worktrees, and a test that touched them could destroy work in a session
// it knows nothing about. A fixture repo therefore has NO commits, which is
// also why these tests assert on untracked counts rather than modified ones,
// and why `HEAD` is expected to be absent rather than a sha.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_SRC = join(REPO, ".claude", "hooks");

/** Every fixture directory made, removed once at the end of the file. */
const temps = [];

after(() => {
  for (const dir of temps) {
    // maxRetries: on Windows a just-exited git process can still hold a handle
    // on .git for a few milliseconds.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A leaked temp directory is not worth failing a suite over.
    }
  }
});

function write(dir, rel, body) {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

/**
 * A disposable repository with this project's hooks copied into it.
 *
 * `init: false` produces a directory that is not a repository at all, which is
 * how the "never fail the session" requirement gets tested: SessionStart output
 * is injected into Claude's context, so a hook that threw there would poison
 * the start of every session.
 */
function fixture({ init = true, branch = "feat/x", files = {}, receipts, overrides, sessionLog } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gml-hook-"));
  temps.push(dir);
  if (init) spawnSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  for (const f of ["_lib.mjs", "session-start.mjs", "stop.mjs"]) {
    const src = join(HOOK_SRC, f);
    if (existsSync(src)) cpSync(src, join(dir, ".claude", "hooks", f));
  }
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  if (receipts) {
    write(dir, "workspace/test-receipts.jsonl", receipts.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  if (overrides) write(dir, "workspace/gate-overrides.log", overrides);
  if (sessionLog) write(dir, "workspace/session_log.md", sessionLog);
  return dir;
}

/** Run a hook exactly as Claude Code does: JSON on stdin, read stdout/stderr/status. */
function runHook(dir, hook, input = {}, env = {}) {
  return spawnSync(process.execPath, [join(dir, ".claude", "hooks", hook)], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    input: JSON.stringify(input),
    // CLAUDE_PROJECT_DIR defaults to the fixture so sessionRootMismatch() is
    // null unless a test deliberately points it elsewhere.
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GML_GATE_SKIP: "" },
  });
}

/**
 * The fixture's tree fingerprint, computed by the fixture's OWN copy of
 * _lib.mjs — so a receipt written with it is green for that tree by
 * construction, rather than by a hash this test recomputes and could get wrong.
 */
async function treeHashOf(dir) {
  const lib = await import(pathToFileURL(join(dir, ".claude", "hooks", "_lib.mjs")).href);
  return lib.treeHash();
}

function lines(out) {
  return out.split(/\r?\n/).filter((l) => l.trim() !== "");
}

// ── SessionStart ─────────────────────────────────────────────────────────────

test("session-start names the repository it is actually rooted in", () => {
  const dir = fixture();
  const r = runHook(dir, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s1" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /repo:/);
  assert.ok(r.stdout.includes(dir), `expected the repo path ${dir} in:\n${r.stdout}`);
});

test("session-start shouts when the session started outside this repository", () => {
  const dir = fixture();
  const elsewhere = mkdtempSync(join(tmpdir(), "gml-elsewhere-"));
  temps.push(elsewhere);
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "session-start.mjs")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: elsewhere },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /SESSION ROOT MISMATCH/);
  assert.ok(r.stdout.includes(elsewhere), `expected the session directory in:\n${r.stdout}`);
  assert.ok(r.stdout.includes(dir), `expected the repo directory in:\n${r.stdout}`);
  // The point of the warning is not "these differ" but "you have NO gates".
  assert.match(r.stdout, /no enforcement/i);
});

test("session-start warns on main and stays quiet on a feature branch", () => {
  const onMain = runHook(fixture({ branch: "main" }), "session-start.mjs", {});
  assert.equal(onMain.status, 0, `stderr: ${onMain.stderr}`);
  assert.match(onMain.stdout, /branch: main/);
  assert.match(onMain.stdout, /switch -c/);

  const onFeature = runHook(fixture({ branch: "feat/x" }), "session-start.mjs", {});
  assert.match(onFeature.stdout, /branch: feat\/x/);
  assert.doesNotMatch(onFeature.stdout, /switch -c/);
});

test("session-start counts dirty FILES, not collapsed directories", () => {
  // Measured as a delta between two fixtures because a fixture necessarily
  // contains the hook copies themselves, and a hardcoded expected total would
  // change the moment a hook file is added to this directory.
  //
  // Three files in ONE new directory is the case that matters: plain
  // `git status --porcelain` reports an untracked directory as a SINGLE row
  // (`?? docs/`), so a session with fifty new files under one folder would be
  // told "1 untracked". This is the exact miscount the first version of this
  // hook shipped with — it reported 4 for this fixture.
  const untrackedIn = (dir) => {
    const r = runHook(dir, "session-start.mjs", {});
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const m = r.stdout.match(/tree: (\d+) modified, (\d+) untracked/);
    assert.ok(m, `expected a tree count in:\n${r.stdout}`);
    return Number(m[2]);
  };

  const before = untrackedIn(fixture());
  const after = untrackedIn(fixture({ files: { "docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c" } }));
  assert.equal(after - before, 3, "three new files under one new directory must count as three");
});

test("session-start says so plainly when there is no test receipt", () => {
  const r = runHook(fixture(), "session-start.mjs", {});
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no test receipt/i);
  // A line that only reports absence teaches nothing; it has to say what to run.
  assert.match(r.stdout, /pnpm test/);
});

test("session-start reports a green receipt as green only while the tree still matches", async () => {
  const dir = fixture({ files: { "apps/web/x.ts": "export const x = 1;\n" } });
  const hash = await treeHashOf(dir);
  const green = {
    ts: new Date().toISOString(),
    branch: "feat/x",
    head: "abc123",
    treeHash: hash,
    suites: [{ suite: "governance", ran: true, status: 0, passed: 120, failed: 0, failing: [] }],
    exitCode: 0,
    noDb: false,
  };
  write(dir, "workspace/test-receipts.jsonl", JSON.stringify(green) + "\n");
  const r = runHook(dir, "session-start.mjs", {});
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /GREEN/);
  assert.match(r.stdout, /governance/);
  assert.match(r.stdout, /tree matches/);

  // Same receipt, tree moved on: the receipt is still green about a tree that
  // no longer exists, which is exactly the false reassurance this replaces.
  write(dir, "apps/web/x.ts", "export const x = 2;\n");
  const stale = runHook(dir, "session-start.mjs", {});
  assert.match(stale.stdout, /STALE/);
  assert.doesNotMatch(stale.stdout, /tree matches/);
});

test("session-start reports a failing receipt as RED with the failure count", async () => {
  const dir = fixture();
  const hash = await treeHashOf(dir);
  write(
    dir,
    "workspace/test-receipts.jsonl",
    JSON.stringify({
      ts: new Date().toISOString(),
      branch: "feat/x",
      head: "abc123",
      treeHash: hash,
      suites: [{ suite: "hooks", ran: true, status: 1, passed: 6, failed: 2, failing: ["a", "b"] }],
      exitCode: 1,
      noDb: false,
    }) + "\n",
  );
  const r = runHook(dir, "session-start.mjs", {});
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /RED/);
  assert.match(r.stdout, /2 FAILED/);
});

test("session-start survives a directory that is not a git repository at all", () => {
  const dir = fixture({ init: false });
  const r = runHook(dir, "session-start.mjs", {});
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, "a session must still be told where it is");
  assert.ok(lines(r.stdout).length <= 15, `SessionStart output must stay short:\n${r.stdout}`);
});

test("session-start stays under ~15 lines and finishes fast without a GitHub remote", () => {
  const dir = fixture({
    files: { "a.txt": "a", "docs/superpowers/plans/p.md": "# p\n- [ ] one\n" },
  });
  const started = Date.now();
  const r = runHook(dir, "session-start.mjs", {});
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(lines(r.stdout).length <= 15, `SessionStart output must stay short:\n${r.stdout}`);
  // No origin, so `gh pr list` cannot say anything useful; spending the 5s
  // timeout on it would delay the start of every session in a worktree.
  assert.doesNotMatch(r.stdout, /^prs:/m);
  assert.ok(elapsed < 5000, `session-start took ${elapsed}ms`);
});

test("session-start announces an unfinished plan and ignores a finished one", () => {
  const open = fixture({
    files: { "docs/superpowers/plans/2026-09-24-enforcement.md": "# Enforcement\n- [x] one\n- [ ] two\n" },
  });
  const r = runHook(open, "session-start.mjs", {});
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /plan:/);
  assert.match(r.stdout, /2026-09-24-enforcement\.md/);

  const done = fixture({
    files: { "docs/superpowers/plans/2026-09-01-done.md": "# Done\n- [x] one\n- [x] two\n" },
  });
  const r2 = runHook(done, "session-start.mjs", {});
  assert.doesNotMatch(r2.stdout, /plan:/);
});

// ── Stop ─────────────────────────────────────────────────────────────────────
//
// The ledger these tests defend is workspace/session_log.md: 112 bytes, a
// header and nothing else, unchanged since the day it was created, across every
// session that produced this project's 27 commits. The script that was supposed
// to fill it appends UNCONDITIONALLY — there is no branch in it that can skip
// the write — so the file's emptiness is proof the hook never executed at all.
// Hence a test that spawns the hook and then READS THE FILE BACK.
//
// ── STOP IS A RECORDER. IT DOES NOT BLOCK ────────────────────────────────────
//
// This section used to assert exit 2 from a BARE `node stop.mjs`, and passed,
// while the registration in settings.json was `node … stop.mjs || true` —
// which returns 0 whatever the script does. The refusal the file described at
// length could not reach Claude Code even once, and no test noticed, because
// this file tested the script and fail-closed.test.mjs tested the registration
// and nothing tested the pair. The pair test now lives in fail-closed.test.mjs
// ("the Stop hook's registration and its file agree about whether it can
// block"); these tests pin the contract that was chosen to settle it.
//
// The contract: Stop writes a ledger line and exits 0, always. What the old
// gate blocked on — source files with no green receipt for this tree — is
// RECORDED in that line instead of refused, because the commit gate in
// pre-bash.mjs already refuses the commit on the same invariant, at the moment
// it matters, and Stop is the one hook whose failure mode is a session the
// user cannot end. So these tests assert exit 0 on the payload that used to
// block, and assert that the ledger line still names the unverified work.

/** Only the entries — a heading or preamble is not a ledger row. */
function ledgerLines(dir) {
  const p = join(dir, "workspace", "session_log.md");
  if (!existsSync(p)) return [];
  return lines(readFileSync(p, "utf8")).filter((l) => l.startsWith("- "));
}

test("stop writes a ledger line that can be checked against the session", () => {
  const dir = fixture({ branch: "feat/ledger", files: { "docs/note.md": "hi" } });
  const r = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-ledger" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const rows = ledgerLines(dir);
  assert.equal(rows.length, 1, `expected exactly one ledger line, got:\n${rows.join("\n")}`);
  const line = rows[0];
  assert.match(line, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "a ledger entry without a timestamp cannot be audited");
  assert.match(line, /feat\/ledger/);
  assert.match(line, /\d+ dirty/);
  assert.match(line, /no receipt/i);
});

test("stop RECORDS unverified source changes instead of refusing to stop", () => {
  const dir = fixture({
    files: { "apps/web/x.ts": "export const x = 1;\n", "scripts/y.mjs": "// y\n", "docs/z.md": "z" },
  });
  const r = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-record" });

  assert.equal(r.status, 0, `Stop must never block; stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.equal(r.stderr.trim(), "", `a recorder says nothing on stderr; got:\n${r.stderr}`);

  // Recording is the whole job, so the line has to carry what the old gate
  // would have refused over: how much of the dirt is SOURCE, and the fact that
  // no receipt covers it. A line that said "3 dirty" and stopped there would
  // leave the reader no better off than the empty file this replaces.
  //
  // The SOURCE count is asserted exactly; the dirty total only as "at least
  // the three files written here", because a fixture necessarily also contains
  // the hook copies it runs — and those live under .claude/hooks/, which is
  // why they move the total without moving the source count.
  const line = ledgerLines(dir).at(-1);
  const m = line.match(/(\d+) dirty \((\d+) source\)/);
  assert.ok(m, `expected a "N dirty (M source)" count in:\n${line}`);
  assert.ok(Number(m[1]) >= 3, `all three written files must be counted dirty; got:\n${line}`);
  assert.equal(Number(m[2]), 2, `docs/z.md is not source, apps/** and scripts/** are; got:\n${line}`);
  assert.match(line, /no receipt/i, `the unverified state must be on the record; got:\n${line}`);
  assert.match(line, /s-record/, "the ledger indexes by session — an entry you cannot attribute is not evidence");
});

test("stop never blocks, whatever the payload", () => {
  // Exit 2 from a Stop hook is what makes Claude Code keep going, so a Stop
  // that can reach exit 2 by ANY route is a session that can refuse to end.
  // The registered command shape hides that (`|| true`), which is why this
  // asserts on the bare process: the file itself must have no such route.
  const payloads = [
    ["nothing at all", {}],
    ["source, no receipt", { hook_event_name: "Stop", session_id: "s-src" }],
    ["a continuation", { hook_event_name: "Stop", session_id: "s-cont", stop_hook_active: true }],
    ["no session id", { hook_event_name: "Stop" }],
    ["a hostile session id", { hook_event_name: "Stop", session_id: "../../etc/passwd" }],
  ];
  for (const [what, payload] of payloads) {
    const dir = fixture({ files: { "apps/web/x.ts": "export const x = 1;\n" } });
    const r = runHook(dir, "stop.mjs", payload);
    assert.equal(r.status, 0, `Stop blocked on ${what}; stderr: ${r.stderr}`);
    assert.equal(ledgerLines(dir).length, 1, `Stop must record on ${what}`);
  }
});

test("stop records every stop and leaves no per-session marker behind", () => {
  // The old gate wrote workspace/.stop-nudged-<session_id> so it would nudge
  // only once. That brake was never durable: appendWorkspace() swallows write
  // failures by design, so anything that makes workspace/ unwritable leaves
  // the marker unarmed and turns "once per session" into every stop, forever.
  // With no nudge there is no marker, and that state file must not come back.
  const dir = fixture({ files: { "packages/db/x.ts": "export const x = 1;\n" } });

  const first = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-42" });
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);
  const second = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-42" });
  assert.equal(second.status, 0, `stderr: ${second.stderr}`);

  assert.equal(ledgerLines(dir).length, 2, "two stops are two entries — the ledger is append-only");

  const left = readdirSync(join(dir, "workspace"));
  assert.deepEqual(
    left.filter((f) => f.startsWith(".stop-nudged")),
    [],
    `no nudge, so no marker; workspace holds: ${left.join(", ")}`,
  );
});

test("stop stays out of the way when a green receipt covers this exact tree", async () => {
  const dir = fixture({ files: { "apps/web/x.ts": "export const x = 1;\n" } });
  const hash = await treeHashOf(dir);
  write(
    dir,
    "workspace/test-receipts.jsonl",
    JSON.stringify({
      ts: new Date().toISOString(),
      branch: "feat/x",
      head: "abc123",
      treeHash: hash,
      suites: [{ suite: "governance", ran: true, status: 0, passed: 12, failed: 0, failing: [] }],
      exitCode: 0,
      noDb: false,
    }) + "\n",
  );
  const r = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-green" });
  assert.equal(r.status, 0, `verified work must stop cleanly; stderr: ${r.stderr}`);
  assert.match(ledgerLines(dir).at(-1), /GREEN/);
});

test("stop records the gate overrides taken since the last ledger entry", () => {
  const dir = fixture({
    files: { "docs/note.md": "hi" },
    sessionLog: "# Session log\n\n- 2026-01-01T00:00:00.000Z · feat/x · none · 0 dirty · no receipt\n",
    overrides:
      "2025-12-31T00:00:00.000Z\tcommit-gate\tbefore this session\n" +
      "2026-01-02T00:00:00.000Z\tcommit-gate\tprod outage hotfix\n",
  });
  const r = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-ovr" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const line = ledgerLines(dir).at(-1);
  assert.match(line, /overrides: 1/);
  assert.match(line, /prod outage hotfix/);
  // An override from a previous session is already in that session's line;
  // repeating it here would inflate every later entry.
  assert.doesNotMatch(line, /before this session/);
});

test("stop exits cleanly outside a git repository rather than blocking every stop", () => {
  const dir = fixture({ init: false, files: { "apps/web/x.ts": "export const x = 1;\n" } });
  const r = runHook(dir, "stop.mjs", { hook_event_name: "Stop", session_id: "s-nogit" });
  assert.equal(r.status, 0, `a hook that cannot read git state must not trap the session; stderr: ${r.stderr}`);
});
