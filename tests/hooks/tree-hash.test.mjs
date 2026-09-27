// The receipt fingerprint, and the two ways it was forgeable. [C3(a), C3(b)]
//
// ── WHAT A TREE FINGERPRINT IS FOR ───────────────────────────────────────────
//
// `scripts/test-gate.mjs` writes a receipt saying which suites ran and what they
// returned, and `pre-bash.mjs` refuses a commit whose tree does not match a
// green receipt. The whole load is carried by one string: if two DIFFERENT trees
// can produce the same fingerprint, the gate accepts evidence from a tree that
// was never tested, and the commit gate becomes decoration.
//
// ── C3(a): EVERY CLEAN TREE HASHED TO THE SAME UNIVERSAL CONSTANT ────────────
//
// The fingerprint hashed `git diff HEAD` plus untracked files, and nothing else.
// On a clean tree with no untracked files that is the empty string, so:
//
//   $ node -e "import('./.claude/hooks/_lib.mjs').then(m=>console.log(m.treeHash()))"
//   e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
//   $ node -e "...createHash('sha256').update('').digest('hex')"
//   e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
//
// Measured on this worktree, which is in exactly that state. A green receipt
// from ANY clean tree — any branch, any commit, any machine, any repository —
// matched every other clean tree. HEAD is now the first thing hashed.
//
// ── C3(b): THE INDEX WAS NOT HASHED AT ALL ───────────────────────────────────
//
// `git diff HEAD` reports the WORKTREE against HEAD. Stage a change and then put
// the worktree file back to HEAD's bytes, and `git diff HEAD` is empty while the
// index — which is what `git commit` writes — carries the payload. Reproduced:
//
//   status                      "MM a.txt"
//   git diff HEAD (worktree)    ""
//   git diff --cached (index)   diff --git a/a.txt b/a.txt ...
//   hash with MALICIOUS staged  e3b0c44298fc1c14...  <- the clean-tree constant
//   staged blob content         "MALICIOUS\n"
//
// `git stash push --keep-index` reaches that same state in one command. The
// fingerprint now hashes `git diff --cached` under its own "index" label.
//
// ── HOW THESE TESTS RUN ──────────────────────────────────────────────────────
//
// Every case builds a throwaway repository under mkdtemp and copies `_lib.mjs`
// into `<sandbox>/.claude/hooks/`, because `treeHash()` resolves PROJECT_DIR
// from its own location — so a copy under the sandbox fingerprints the SANDBOX.
// Commits are made with `write-tree`/`commit-tree`/`update-ref`: no `git commit`,
// no `git reset --hard`, and nothing here touches the real repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LIB = resolve(ROOT, ".claude", "hooks", "_lib.mjs");
const GATE = resolve(ROOT, "scripts", "test-gate.mjs");

/**
 * sha256(""), spelled out.
 *
 * Named rather than inlined so a reader of a failure sees WHICH constant was
 * hit: this is the value a fingerprint collapses to when it hashes nothing.
 */
const SHA256_OF_NOTHING = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const SANDBOXES = [];
process.on("exit", () => {
  for (const dir of SANDBOXES) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A leftover temp directory is not worth failing a suite over.
    }
  }
});

/** A disposable git repository with its own copy of the hook library. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gml-treehash-"));
  SANDBOXES.push(root);

  // An identity in the environment as well as in config: `commit-tree` refuses
  // to run without one, and a developer machine may have no global git user.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "gate-test",
    GIT_AUTHOR_EMAIL: "gate-test@example.invalid",
    GIT_COMMITTER_NAME: "gate-test",
    GIT_COMMITTER_EMAIL: "gate-test@example.invalid",
  };

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 30_000,
    }).trim();

  git("init", "-q", "-b", "main");
  git("config", "user.name", "gate-test");
  git("config", "user.email", "gate-test@example.invalid");

  // The fingerprint walks `git ls-files -o --exclude-standard`, so whatever the
  // developer has in a GLOBAL excludesFile would otherwise change what these
  // tests measure. Point it at an empty file inside the sandbox instead.
  const excludes = join(root, ".git", "empty-excludes");
  writeFileSync(excludes, "");
  git("config", "core.excludesFile", excludes);
  writeFileSync(join(root, ".git", "info", "exclude"), "");

  const write = (rel, content) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };

  const remove = (rel) => rmSync(join(root, rel), { force: true });

  const head = () => {
    try {
      return git("rev-parse", "HEAD");
    } catch {
      return "";
    }
  };

  /** Commit the current index with plumbing — tests must not run `git commit`. */
  const commit = (message) => {
    const tree = git("write-tree");
    const parent = head();
    const args = ["commit-tree", tree, "-m", message];
    if (parent) args.push("-p", parent);
    const sha = git(...args);
    git("update-ref", "refs/heads/main", sha);
    return sha;
  };

  // Each sandbox has a unique path, so each gets its own module instance and
  // its own PROJECT_DIR — no cache bleed between cases.
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  copyFileSync(LIB, join(root, ".claude", "hooks", "_lib.mjs"));
  const load = () => import(pathToFileURL(join(root, ".claude", "hooks", "_lib.mjs")).href);

  /** A repository with one committed source file and a clean worktree. */
  const seed = () => {
    write("src/app.js", "export const rate = 1;\n");
    write("README.md", "# sandbox\n");
    git("add", "-A");
    const sha = commit("initial");
    assert.equal(git("status", "--porcelain"), "", "a freshly seeded sandbox must be clean");
    return sha;
  };

  return { root, git, write, remove, commit, head, load, seed, env };
}

// ─── C3(a) ───────────────────────────────────────────────────────────────────

test("a clean tree does NOT fingerprint to sha256 of nothing", async () => {
  const s = sandbox();
  s.seed();
  const lib = await s.load();

  const hash = lib.treeHash();
  assert.notEqual(
    hash,
    SHA256_OF_NOTHING,
    `a clean tree fingerprinted to sha256("") — a constant every clean tree on every ` +
      `branch in every repository shares. A green receipt from any of them would satisfy ` +
      `the commit gate here. HEAD must be part of the fingerprint.`,
  );
});

test("two clean trees at DIFFERENT commits fingerprint differently", async () => {
  const s = sandbox();
  s.seed();
  const lib = await s.load();

  const first = s.head();
  const atFirst = lib.treeHash();

  s.write("src/app.js", "export const rate = 2;\n");
  s.git("add", "-A");
  const second = s.commit("second");
  assert.notEqual(first, second, "precondition: the sandbox must now be at a different commit");
  assert.equal(s.git("status", "--porcelain"), "", "precondition: the worktree must be clean again");

  const atSecond = lib.treeHash();
  assert.notEqual(
    atSecond,
    atFirst,
    `two clean trees at different commits shared a fingerprint (${atFirst.slice(0, 12)}), so a ` +
      `receipt earned at ${first.slice(0, 8)} was accepted as evidence for ${second.slice(0, 8)}. ` +
      `The commit being built on is part of what was tested.`,
  );
});

// ─── C3(b) ───────────────────────────────────────────────────────────────────

test("staging a change changes the fingerprint", async () => {
  const s = sandbox();
  s.seed();
  const lib = await s.load();
  const clean = lib.treeHash();

  // The forgery, exactly as reproduced: stage the payload, then restore the
  // worktree file to HEAD's bytes. `git stash push --keep-index` gets here in
  // one command. `git commit` writes the INDEX, so this is what would land.
  const payload = "export const rate = 1;\nexport const backdoor = true;\n";
  s.write("src/app.js", payload);
  s.git("add", "src/app.js");
  s.write("src/app.js", "export const rate = 1;\n");

  assert.equal(
    s.git("diff", "HEAD", "--binary"),
    "",
    "precondition: the worktree must match HEAD, which is what made this invisible",
  );
  assert.notEqual(
    s.git("diff", "--cached", "--binary"),
    "",
    "precondition: the index must carry the change",
  );
  assert.equal(
    s.git("show", ":src/app.js"),
    payload.trim(),
    "precondition: the staged blob is what a commit would write",
  );

  const staged = lib.treeHash();
  assert.notEqual(
    staged,
    clean,
    `a tree with ${JSON.stringify(payload.split("\n")[1])} STAGED fingerprinted identically to the ` +
      `clean tree (${clean.slice(0, 12)}). The fingerprint hashed \`git diff HEAD\`, which reports ` +
      `the worktree; \`git commit\` writes the index. The index must be hashed too.`,
  );
});

test("a change STAGED and the same change left UNSTAGED fingerprint differently", async () => {
  // Guard on the shape of the fix rather than on the defect: worktree and index
  // must occupy their own slots, so that moving a change between them is visible
  // rather than a no-op.
  //
  // Both readings are taken in ONE sandbox. Taken in two, the commit SHAs differ
  // (different timestamps), so the hashes would differ for that reason alone and
  // the test would pass without proving anything.
  const s = sandbox();
  const commit = s.seed();
  const lib = await s.load();

  // Staged only: the index carries the change, the worktree is back at HEAD.
  s.write("src/app.js", "export const rate = 9;\n");
  s.git("add", "src/app.js");
  s.write("src/app.js", "export const rate = 1;\n");
  const stagedOnly = lib.treeHash();

  // Unstaged only: the same bytes, now in the worktree, index back at HEAD.
  // A path-limited mixed reset — never `--hard`, which the Bash gate refuses.
  s.git("reset", "-q", "HEAD", "--", "src/app.js");
  s.write("src/app.js", "export const rate = 9;\n");
  const unstagedOnly = lib.treeHash();

  assert.equal(s.head(), commit, "precondition: HEAD must not move between the two readings");
  assert.equal(
    s.git("diff", "--cached", "--binary"),
    "",
    "precondition: the index must be back at HEAD for the second reading",
  );
  assert.notEqual(
    unstagedOnly,
    stagedOnly,
    "a staged change and an unstaged one describe different things a commit would produce, " +
      "so they must not share a fingerprint",
  );
});

// ─── Stability and scope ─────────────────────────────────────────────────────

test("the same tree fingerprints identically twice", async () => {
  // A fingerprint that wandered would refuse every commit, and the layer would
  // be removed within the hour. Measured on a tree that is dirty in all three
  // ways at once, since that exercises every part of the input.
  const s = sandbox();
  s.seed();
  const lib = await s.load();

  s.write("src/app.js", "export const rate = 3;\n");
  s.git("add", "src/app.js");
  s.write("README.md", "# sandbox, edited\n");
  s.write("notes-untracked.txt", "scratch\n");

  const first = lib.treeHash();
  const second = lib.treeHash();
  assert.equal(first, second, "the fingerprint of an unchanged tree must be stable");
});

test("a change under workspace/ does NOT change the fingerprint", async () => {
  // workspace/ holds the receipts themselves. Including it would make every
  // receipt stale the instant it was written.
  const s = sandbox();
  s.seed();
  const lib = await s.load();
  const before = lib.treeHash();

  s.write("workspace/test-receipts.jsonl", `${JSON.stringify({ ts: "now", exitCode: 0 })}\n`);
  assert.ok(
    s.git("ls-files", "-o", "--exclude-standard").split(/\r?\n/).includes("workspace/test-receipts.jsonl"),
    "precondition: workspace/ is deliberately NOT ignored here, so the exclusion under test " +
      "is the fingerprint's own filter rather than gitignore doing the work",
  );

  assert.equal(
    lib.treeHash(),
    before,
    "writing a receipt under workspace/ changed the fingerprint, which would make every receipt " +
      "stale the moment it was recorded",
  );

  s.write("workspace/session_log.md", "# log\nanother line\n");
  assert.equal(lib.treeHash(), before, "a second file under workspace/ must also be ignored");
});

test("an untracked file changes the fingerprint, and removing it restores it", async () => {
  // A new source file with no test is exactly what the commit gate exists to
  // catch, and it is untracked right up until the commit.
  const s = sandbox();
  s.seed();
  const lib = await s.load();
  const before = lib.treeHash();

  s.write("src/new-feature.js", "export function untested() { return 42; }\n");
  const withFile = lib.treeHash();
  assert.notEqual(withFile, before, "an untracked source file must change the fingerprint");

  s.remove("src/new-feature.js");
  assert.equal(
    lib.treeHash(),
    before,
    "removing the untracked file must restore the original fingerprint — otherwise the " +
      "fingerprint depends on history rather than on the tree",
  );
});

// ─── The receipt must bind to the tree that was TESTED ───────────────────────

/**
 * A stand-in for `pnpm run <script>`.
 *
 * The gate shells out to pnpm on purpose — the suite globs stay in package.json
 * so tests/governance/test_111 can still resolve the `pnpm test` chain and prove
 * it never reaches tests/integration. But a unit test of the gate's ORDERING must
 * not depend on a real package manager: measured here, `pnpm run` inside a fresh
 * git sandbox dies with Windows exit 1073741845 (STATUS_FATAL_APP_EXIT) writing
 * nothing to either stream, while the same call in a plain temp directory
 * succeeds. That would make this a coin flip rather than a check.
 *
 * Resolving the named script out of package.json and running it is the only part
 * of pnpm the gate actually relies on, so that is all the shim does.
 */
const PNPM_SHIM = `// Stand-in for pnpm. Supports exactly: pnpm run <script>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [verb, name] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const cmd = verb === "run" && name ? (pkg.scripts || {})[name] : null;
if (!cmd) {
  console.error("pnpm-shim: cannot run: " + process.argv.slice(2).join(" "));
  process.exit(2);
}
const r = spawnSync(cmd, { cwd: process.cwd(), stdio: "inherit", shell: true });
process.exit(r.status === null ? 1 : r.status);
`;

/** A sandbox laid out like the repository, with the gate, its library and the shim. */
function gateSandbox(suiteScript) {
  const s = sandbox();
  s.seed();
  mkdirSync(join(s.root, "scripts"), { recursive: true });
  copyFileSync(GATE, join(s.root, "scripts", "test-gate.mjs"));
  s.write(
    "package.json",
    `${JSON.stringify({ name: "gate-sandbox", private: true, scripts: { "test:governance": suiteScript } }, null, 2)}\n`,
  );

  s.write("bin/pnpm-shim.mjs", PNPM_SHIM);
  if (process.platform === "win32") {
    // cmd.exe resolves a bare `pnpm` through PATH + PATHEXT, so a .cmd wins.
    s.write("bin/pnpm.cmd", '@echo off\r\nnode "%~dp0pnpm-shim.mjs" %*\r\n');
  } else {
    chmodSync(s.write("bin/pnpm", '#!/bin/sh\nexec node "$(dirname "$0")/pnpm-shim.mjs" "$@"\n'), 0o755);
  }

  // Committed, so that nothing the harness itself adds counts as the tree moving.
  s.git("add", "-A");
  s.commit("gate sandbox");
  assert.equal(s.git("status", "--porcelain"), "", "the gate sandbox must start clean");
  return s;
}

/**
 * The environment for a gate run, with the sandbox's bin/ first on PATH.
 *
 * Windows spells the variable `Path`; spreading process.env and then setting
 * `PATH` would leave two keys differing only in case, and which one the child
 * sees is not defined. Drop every casing first, then set one.
 */
function gateEnv(s) {
  const out = {};
  let inherited = "";
  for (const [k, v] of Object.entries(s.env)) {
    if (k.toLowerCase() === "path") {
      inherited = v ?? "";
      continue;
    }
    out[k] = v;
  }
  out.PATH = join(s.root, "bin") + (process.platform === "win32" ? ";" : ":") + inherited;
  out.DATABASE_URL = "";
  out.TEST_DATABASE_URL = "";
  return out;
}

function runGate(s) {
  return spawnSync(process.execPath, [join(s.root, "scripts", "test-gate.mjs"), "governance"], {
    cwd: s.root,
    encoding: "utf8",
    env: gateEnv(s),
    timeout: 5 * 60_000,
  });
}

function readReceipt(s) {
  const lines = readFileSync(join(s.root, "workspace", "test-receipts.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one receipt, got ${lines.length}`);
  return JSON.parse(lines[0]);
}

test("the receipt fingerprints the tree the suites RAN against, not the tree left behind", async () => {
  // The gate used to call treeHash() only when building the receipt — AFTER the
  // suites had run. A suite that writes anything (a coverage file, a generated
  // fixture, a snapshot) moved the tree, and the receipt then described a tree
  // nobody had tested. Here the "suite" mutates the tree on purpose.
  const s = gateSandbox(
    `node -e "require('fs').writeFileSync('generated-during-run.txt','artifact');console.log('TAP version 13');console.log('# pass 1');console.log('# fail 0')"`,
  );
  const lib = await s.load();
  const beforeRun = lib.treeHash();

  const r = runGate(s);
  assert.equal(r.status, 0, `the sandbox suite should pass. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const afterRun = lib.treeHash();
  assert.notEqual(afterRun, beforeRun, "precondition: the sandbox suite must have moved the tree");

  const receipt = readReceipt(s);
  assert.equal(
    receipt.treeHash,
    beforeRun,
    `the receipt must fingerprint the tree that was TESTED (${beforeRun.slice(0, 12)}), not the one ` +
      `left behind (${afterRun.slice(0, 12)}). Recorded: ${String(receipt.treeHash).slice(0, 12)}.`,
  );
  assert.equal(
    receipt.treeHashAfter,
    afterRun,
    "when the tree moves mid-run the receipt must record BOTH fingerprints, so a consumer can " +
      "tell the difference between a stale receipt and a suite that writes files",
  );
});

test("a run that leaves the tree alone records no treeHashAfter", async () => {
  // The other direction: `treeHashAfter` means "the tree moved". Emitting it
  // unconditionally would make it noise, and a consumer would learn to skip it.
  const s = gateSandbox(
    `node -e "console.log('TAP version 13');console.log('# pass 2');console.log('# fail 0')"`,
  );
  const lib = await s.load();
  const beforeRun = lib.treeHash();

  const r = runGate(s);
  assert.equal(r.status, 0, `the sandbox suite should pass. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const receipt = readReceipt(s);
  assert.equal(receipt.treeHash, beforeRun, "a stable run must fingerprint that stable tree");
  assert.equal(
    receipt.treeHashAfter,
    undefined,
    "treeHashAfter must appear only when the tree actually moved during the run",
  );
  assert.equal(receipt.head, s.head(), "the receipt must name the commit the suites ran on");
});
