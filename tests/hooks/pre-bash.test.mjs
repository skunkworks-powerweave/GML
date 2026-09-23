// pre-bash.mjs — driven the way Claude Code drives it: spawned, JSON on stdin.
//
// ── WHY THESE ARE SPAWN TESTS AND NOT UNIT TESTS ─────────────────────────────
//
// The hooks this replaces were never once executed by a test, and they enforced
// nothing for the life of the project — because the CONTRACT was wrong, not the
// logic. `node scripts/block_destructive.mjs "$TOOL_INPUT"` read argv[2] from an
// environment variable that does not exist in the binary, so the one blocking
// hook in the project matched nothing, ever. A unit test that imported a
// `isDestructive()` function would have passed the whole time.
//
// So every test here spawns the real file with real JSON on stdin and asserts on
// the real exit code. Exit 2 is the only thing that blocks a PreToolUse; a test
// that does not observe the exit code is not testing the gate.
//
// ── WHY MOST TESTS RUN AGAINST THE REAL REPO, AND SOME DO NOT ────────────────
//
// The rules that need no git state (destructive scan, explicit push refspecs,
// worktree paths) are driven with synthetic stdin against the real repo. That is
// safe by construction: the hook is a PreToolUse gate, so it INSPECTS a command
// string and exits — it never runs the command it was asked about. Nothing is
// mutated because nothing is executed.
//
// The rules that read git state (branch, staged paths, receipts) cannot be
// tested that way without staging files in the real repository. Those use
// `sandbox()`, which copies the hook and its library into a temp repo. That copy
// is what makes it work: `_lib.PROJECT_DIR` is derived from the HOOK FILE's own
// location, not from cwd or $CLAUDE_PROJECT_DIR, so a copy under a temp
// directory acts on the temp repo and cannot reach this one.
//
// No test in this file runs `git commit`, `git push`, or docker. The sandbox
// deliberately has NO commits at all: `git diff --cached --name-only` reports
// staged paths in a repo with no HEAD, so a commit was never needed to test the
// commit gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOK = ".claude/hooks/pre-bash.mjs";
const LIB = ".claude/hooks/_lib.mjs";

/**
 * Drive the hook exactly as the harness does: `node .claude/hooks/pre-bash.mjs`
 * with the PreToolUse payload on stdin.
 *
 * The hook path is RELATIVE so that it resolves against `cwd` — that is what
 * makes a sandbox run use the sandbox's copy of the hook (and therefore the
 * sandbox's PROJECT_DIR) rather than this repo's.
 *
 * GML_GATE_SKIP is pinned to "" so that an override left in the ambient
 * environment cannot silently turn a blocking assertion green.
 */
function run(command, { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
    env: { ...process.env, GML_GATE_SKIP: "", ...env },
  });
  if (r.error) assert.fail(`could not spawn ${HOOK}: ${r.error.message}`);
  return r;
}

/** Assert the command was BLOCKED, and that the reason names the rule. */
function assertBlocked(r, ...mustMention) {
  assert.equal(
    r.status,
    2,
    `expected exit 2 (blocked); got ${r.status}. stderr=${r.stderr} stdout=${r.stdout}`,
  );
  for (const needle of mustMention) {
    assert.match(r.stderr, needle);
  }
}

/** Assert the command was ALLOWED. */
function assertAllowed(r) {
  assert.equal(r.status, 0, `expected exit 0 (allowed); got ${r.status}. stderr=${r.stderr}`);
}

/** git, for setting a sandbox up. Never run against ROOT — see sandbox(). */
function setupGit(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) assert.fail(`sandbox setup: git ${args.join(" ")} → ${r.stderr}`);
}

/**
 * A throwaway repository with its own copy of the hook.
 *
 * The copy is the whole point: PROJECT_DIR in _lib.mjs is derived from the hook
 * FILE's location, so the copy under tmp acts on the tmp repo. A test can stage
 * files and forge receipts there with no way to reach this repository.
 *
 * There are NO COMMITS here, on purpose. `git diff --cached --name-only` lists
 * staged paths in a repo with an unborn HEAD, so the commit gate can be driven
 * end to end without this file ever running `git commit`.
 */
function sandbox({ branch = "feature/x", files = {}, staged = [], receipts = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pre-bash-"));
  setupGit(dir, ["init", "-q", "-b", branch, "."]);

  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  copyFileSync(resolve(ROOT, LIB), join(dir, ".claude", "hooks", "_lib.mjs"));
  copyFileSync(resolve(ROOT, HOOK), join(dir, ".claude", "hooks", "pre-bash.mjs"));

  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  if (staged.length) setupGit(dir, ["add", "--", ...staged]);

  if (receipts.length) writeReceipts(dir, receipts);
  return dir;
}

/**
 * Forge the receipts file. Written after the sandbox exists so that a test can
 * compute the tree hash FIRST and then claim it — the honest ordering, and the
 * only way to exercise a receipt that genuinely matches the tree.
 *
 * Safe to write at any point: treeHash() excludes workspace/, so the receipts
 * file cannot change the hash it is claiming.
 */
function writeReceipts(dir, list) {
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(
    join(dir, "workspace", "test-receipts.jsonl"),
    list.map((r) => `${JSON.stringify(r)}\n`).join(""),
  );
}

/**
 * The sandbox's own treeHash, computed by the sandbox's own copy of _lib.
 *
 * Importing the copy rather than reimplementing the hash means a test that
 * claims "this receipt matches the tree" cannot drift from what the hook
 * computes — the two would have to disagree with themselves.
 */
async function sandboxTreeHash(dir) {
  const lib = await import(pathToFileURL(join(dir, ".claude", "hooks", "_lib.mjs")).href);
  return lib.treeHash();
}

/** A receipt shaped exactly like the one scripts/test-gate.mjs appends. */
function receipt(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    branch: "feature/x",
    head: "0".repeat(40),
    treeHash: "unmatched".padEnd(64, "0"),
    suites: [{ suite: "governance", ran: true, status: 0, passed: 10, failed: 0, failing: [] }],
    exitCode: 0,
    noDb: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DESTRUCTIVE COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

test("1. destructive commands are blocked", () => {
  const destructive = [
    "rm -rf node_modules",
    "rm -fr /tmp/x",
    "rm -r -f build",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git clean -xfd",
    "git stash drop",
    "git stash clear",
    "docker compose down -v",
    "docker compose down --volumes",
    "docker volume rm gml_pgdata",
  ];
  for (const command of destructive) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. destructive SQL is blocked even inside a heredoc", () => {
  // The only shape this actually arrives in. A gate that looked only at the
  // command line would miss every real DROP this project could issue.
  const sql = "psql \"$DATABASE_URL\" <<'SQL'\nDROP TABLE users;\nSQL";
  assertBlocked(run(sql), /destructive/i);
  assertBlocked(run('psql -c "TRUNCATE audit_log"'), /destructive/i);
  assertBlocked(run('psql -c "DROP DATABASE gml"'), /destructive/i);
});

test("1. destructive commands hide behind separators and padding", () => {
  // `git   commit` is called out in the brief; the same evasion applies here.
  assertBlocked(run("echo starting && rm -rf .next"), /destructive/i);
  assertBlocked(run("pnpm build; git reset --hard"), /destructive/i);
  assertBlocked(run("git    clean   -fd"), /destructive/i);
  assertBlocked(run("cd apps/web\nrm -rf node_modules"), /destructive/i);
});

test("1. destructive commands cannot be overridden", () => {
  // Rule 1 is the one gate with no escape hatch: an override exists so a WRONG
  // gate can be worked past, and there is no circumstance where `rm -rf` needs
  // to run through a tool call rather than a human's own shell.
  assertBlocked(run("GML_GATE_SKIP=urgent rm -rf node_modules"), /destructive/i);
  assertBlocked(run("rm -rf node_modules", { env: { GML_GATE_SKIP: "urgent" } }), /destructive/i);
});

test("1. harmless commands are allowed", () => {
  for (const command of [
    "ls -la",
    "pnpm test",
    "rm -f apps/web/tsconfig.tsbuildinfo",
    "git status",
    "echo 'we must never TRUNCATE.'",
    "node --test tests/hooks/pre-bash.test.mjs",
  ]) {
    assertAllowed(run(command));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NO COMMIT ON main/master
// ─────────────────────────────────────────────────────────────────────────────

test("2. committing on main or master is blocked, with the worktree way out", () => {
  for (const branch of ["main", "master"]) {
    const dir = sandbox({ branch });
    const r = run("git commit -m 'wip'", { cwd: dir });
    assertBlocked(r, /protected branch/i, /git worktree add \.worktrees\//);
  }
});

test("2. the branch rule sees past git's global options and padding", () => {
  const dir = sandbox({ branch: "main" });
  for (const command of [
    "git   commit   -m x",
    "git -C . commit -m x",
    "git --no-pager commit -m x",
    "git -c user.name=x commit -m x",
    "pnpm build && git commit -am x",
  ]) {
    assertBlocked(run(command, { cwd: dir }), /protected branch/i);
  }
});

test("2. the branch rule cannot be overridden", () => {
  const dir = sandbox({ branch: "main" });
  assertBlocked(run("git commit -m x", { cwd: dir, env: { GML_GATE_SKIP: "urgent" } }), /protected branch/i);
  assertBlocked(run("GML_GATE_SKIP=urgent git commit -m x", { cwd: dir }), /protected branch/i);
});

test("2. a commit aimed at another repository is out of this gate's scope", () => {
  // `git -C <elsewhere> commit` would be checked against THIS worktree's branch
  // and THIS worktree's receipt — evidence about the wrong tree. Refusing is the
  // only honest answer, and it is the obvious way past the rule above.
  const dir = sandbox({ branch: "feature/x" });
  assertBlocked(run("git -C ../elsewhere commit -m x", { cwd: dir }), /another repository/i);
});

test("2. a feature branch is not refused for being a protected branch", () => {
  const dir = sandbox({ branch: "feature/x" });
  assert.doesNotMatch(run("git commit -m x", { cwd: dir }).stderr, /protected branch/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NO COMMIT WITHOUT A GREEN RECEIPT FOR THIS EXACT TREE
// ─────────────────────────────────────────────────────────────────────────────

test("3. a commit with no receipt at all is blocked", () => {
  const dir = sandbox();
  assertBlocked(run("git commit -m x", { cwd: dir }), /no test receipt/i, /pnpm test/);
});

test("3. a commit on a receipt whose tests failed is blocked, naming the suite", () => {
  const dir = sandbox({
    receipts: [
      receipt({
        exitCode: 1,
        suites: [
          { suite: "governance", ran: true, status: 1, passed: 8, failed: 2, failing: ["test_011 moat"] },
        ],
      }),
    ],
  });
  const r = run("git commit -m x", { cwd: dir });
  assertBlocked(r, /tests failed/i, /governance/, /pnpm test/);
});

test("3. a receipt for a DIFFERENT tree is blocked as stale", async () => {
  const dir = sandbox();
  // Green, but describing a tree that is not this one — which is the whole
  // reason a receipt records a fingerprint instead of just a verdict.
  writeReceipts(dir, [receipt({ exitCode: 0, treeHash: "f".repeat(64) })]);
  const r = run("git commit -m x", { cwd: dir });
  assertBlocked(r, /stale receipt/i, /pnpm test/);
  assert.doesNotMatch(r.stderr, /no test receipt/i);
});

test("3. a green receipt for THIS tree lets the commit through", async () => {
  const dir = sandbox();
  writeReceipts(dir, [receipt({ exitCode: 0, treeHash: await sandboxTreeHash(dir) })]);
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("3. the NEWEST receipt is the one that counts", async () => {
  const dir = sandbox();
  // An older green receipt must not cover a newer red run. Receipts are
  // append-only, so "the last line wins" is the only reading that is not a
  // licence to keep a stale pass around forever.
  writeReceipts(dir, [
    receipt({ exitCode: 0, treeHash: await sandboxTreeHash(dir) }),
    receipt({ exitCode: 1, treeHash: await sandboxTreeHash(dir) }),
  ]);
  assertBlocked(run("git commit -m x", { cwd: dir }), /tests failed/i);
});

test("3. a noDb receipt does not cover a commit that touches apps/ or packages/", async () => {
  for (const codePath of ["apps/web/src/page.tsx", "packages/db/src/index.ts"]) {
    const dir = sandbox({
      files: { [codePath]: "export const x = 1;\n", "tests/behaviour/x.test.ts": "// test\n" },
      staged: [codePath, "tests/behaviour/x.test.ts"],
    });
    writeReceipts(dir, [receipt({ exitCode: 0, noDb: true, treeHash: await sandboxTreeHash(dir) })]);
    const r = run("git commit -m x", { cwd: dir });
    assertBlocked(r, /without a database/i, new RegExp(codePath.split("/")[0]));
  }
});

test("3. a noDb receipt is fine for a commit that touches neither", async () => {
  const dir = sandbox({
    files: { "docs/architecture.md": "# docs\n" },
    staged: ["docs/architecture.md"],
  });
  writeReceipts(dir, [receipt({ exitCode: 0, noDb: true, treeHash: await sandboxTreeHash(dir) })]);
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("3. the receipt rule is overridable, and the override is recorded", () => {
  const dir = sandbox();
  const r = run("GML_GATE_SKIP='hotfix: CI is down' git commit -m x", { cwd: dir });
  assertAllowed(r);
  const log = readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8");
  assert.match(log, /hotfix: CI is down/);
});

/** A sandbox whose latest receipt is green and matches its tree, so that a test
 *  about a LATER rule is not silently satisfied by rule 3 firing first. */
async function greenSandbox(opts = {}) {
  const dir = sandbox(opts);
  writeReceipts(dir, [receipt({ exitCode: 0, treeHash: await sandboxTreeHash(dir) })]);
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TEST-WITH-CODE
// ─────────────────────────────────────────────────────────────────────────────

test("4. code staged with no test staged beside it is blocked", async () => {
  const cases = [
    ["apps/web/src/page.tsx", /tests\/behaviour/],
    ["packages/shared/src/zod.ts", /tests\/behaviour/],
    ["scripts/deploy.sh", /tests\/scripts/],
    ["docker/Dockerfile.web", /tests\//],
  ];
  for (const [codePath, mustMention] of cases) {
    const dir = await greenSandbox({ files: { [codePath]: "x\n" }, staged: [codePath] });
    const r = run("git commit -m x", { cwd: dir });
    assertBlocked(r, /evidence per artefact/i, mustMention);
    assert.match(r.stderr, new RegExp(codePath.replace(/[.]/g, "\.")));
  }
});

test("4. code staged WITH a test under tests/ is allowed", async () => {
  const dir = await greenSandbox({
    files: { "apps/web/src/page.tsx": "x\n", "tests/behaviour/page.test.ts": "// test\n" },
    staged: ["apps/web/src/page.tsx", "tests/behaviour/page.test.ts"],
  });
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("4. a commit that stages no code at all is not asked for a test", async () => {
  const dir = await greenSandbox({
    files: { "docs/architecture.md": "# x\n", "specs/001-x/spec.md": "# x\n" },
    staged: ["docs/architecture.md", "specs/001-x/spec.md"],
  });
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("4. a test file is not itself the code that needs covering", async () => {
  // apps/web/src/page.test.tsx is a test. Demanding a SECOND test for it would
  // be the rule eating its own tail.
  const dir = await greenSandbox({
    files: { "apps/web/src/page.test.tsx": "// test\n" },
    staged: ["apps/web/src/page.test.tsx"],
  });
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("4. the test-with-code rule is overridable, and the override is recorded", async () => {
  const dir = await greenSandbox({ files: { "apps/web/src/p.tsx": "x\n" }, staged: ["apps/web/src/p.tsx"] });
  assertAllowed(run("GML_GATE_SKIP='pure rename' git commit -m x", { cwd: dir }));
  assert.match(readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8"), /pure rename/);
});

/**
 * Turn everything staged into a commit using PLUMBING.
 *
 * `git commit` is forbidden in this file, and rightly — but rule 5 draws a line
 * between a migration that is ADDED and one that is EDITED, and that line does
 * not exist in a repo with no history: with an unborn HEAD every staged path is
 * an addition. write-tree/commit-tree/update-ref builds the history this one
 * distinction needs, inside the temp repo, without invoking the porcelain the
 * rule is about.
 */
function commitStagedViaPlumbing(dir) {
  const tree = spawnSync("git", ["write-tree"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const ident = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const sha = spawnSync("git", ["commit-tree", tree, "-m", "base"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...ident },
  }).stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/, "plumbing commit failed");
  setupGit(dir, ["update-ref", "HEAD", sha]);
}

const SCHEMA = "packages/db/src/schema/users.ts";
const MIGRATION = "packages/db/src/migrations/0031_add_users_locale.sql";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const SCHEMA_TEST = "tests/behaviour/users_schema.test.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 5. SCHEMA CHANGES NEED A MIGRATION
// ─────────────────────────────────────────────────────────────────────────────

test("5. a schema change with no migration is blocked", async () => {
  const dir = await greenSandbox({
    files: { [SCHEMA]: "export const users = 1;\n", [SCHEMA_TEST]: "// t\n" },
    staged: [SCHEMA, SCHEMA_TEST],
  });
  assertBlocked(run("git commit -m x", { cwd: dir }), /new numbered migration/i, /_journal\.json/);
});

test("5. a migration under _post/ does not satisfy the rule, and the reason is given", async () => {
  const dir = await greenSandbox({
    files: {
      [SCHEMA]: "export const users = 1;\n",
      "packages/db/src/migrations/_post/007_grants.sql": "GRANT SELECT ON t TO r;\n",
      [SCHEMA_TEST]: "// t\n",
    },
    staged: [SCHEMA, "packages/db/src/migrations/_post/007_grants.sql", SCHEMA_TEST],
  });
  const r = run("git commit -m x", { cwd: dir });
  assertBlocked(r, /_post/, /drizzle-kit/i, /journal/i);
});

test("5. a numbered migration with no journal entry is blocked", async () => {
  const dir = await greenSandbox({
    files: { [SCHEMA]: "export const users = 1;\n", [MIGRATION]: "ALTER TABLE users ADD COLUMN locale text;\n", [SCHEMA_TEST]: "// t\n" },
    staged: [SCHEMA, MIGRATION, SCHEMA_TEST],
  });
  assertBlocked(run("git commit -m x", { cwd: dir }), /_journal\.json/, /MISSING/);
});

test("5. schema + a new numbered migration + the journal is allowed", async () => {
  const dir = await greenSandbox({
    files: {
      [SCHEMA]: "export const users = 1;\n",
      [MIGRATION]: "ALTER TABLE users ADD COLUMN locale text;\n",
      [JOURNAL]: '{"entries":[]}\n',
      [SCHEMA_TEST]: "// t\n",
    },
    staged: [SCHEMA, MIGRATION, JOURNAL, SCHEMA_TEST],
  });
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("5. EDITING an already-applied migration is not a new migration", async () => {
  const dir = sandbox({
    files: {
      [SCHEMA]: "export const users = 1;\n",
      [MIGRATION]: "-- as applied\n",
      [JOURNAL]: '{"entries":[]}\n',
      [SCHEMA_TEST]: "// t\n",
    },
    staged: [SCHEMA, MIGRATION, JOURNAL, SCHEMA_TEST],
  });
  commitStagedViaPlumbing(dir);

  // Now change the schema and rewrite history in the applied migration instead
  // of adding a new one — the shape that silently diverges a deployed database
  // from the journal.
  writeFileSync(join(dir, SCHEMA), "export const users = 2;\n");
  writeFileSync(join(dir, MIGRATION), "-- quietly edited\n");
  writeFileSync(join(dir, SCHEMA_TEST), "// t2\n");
  setupGit(dir, ["add", "-A"]);
  writeReceipts(dir, [receipt({ exitCode: 0, treeHash: await sandboxTreeHash(dir) })]);

  assertBlocked(run("git commit -m x", { cwd: dir }), /new numbered migration/i);
});

test("5. the migration rule is overridable, and the override is recorded", async () => {
  const dir = await greenSandbox({
    files: { [SCHEMA]: "export const users = 1;\n", [SCHEMA_TEST]: "// t\n" },
    staged: [SCHEMA, SCHEMA_TEST],
  });
  assertAllowed(run("GML_GATE_SKIP='comment-only schema edit' git commit -m x", { cwd: dir }));
  assert.match(readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8"), /comment-only/);
});

test("5. a commit that does not touch the schema is not asked for a migration", async () => {
  const dir = await greenSandbox({
    files: { "packages/db/src/queue.ts": "export const q = 1;\n", "tests/behaviour/q.test.ts": "// t\n" },
    staged: ["packages/db/src/queue.ts", "tests/behaviour/q.test.ts"],
  });
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. NO PUSH TO main, NO FORCE PUSH
// ─────────────────────────────────────────────────────────────────────────────

test("6. a force push is blocked whatever it targets", () => {
  for (const command of [
    "git push --force origin feature/x",
    "git push -f origin feature/x",
    "git push --force-with-lease origin feature/x",
    "git push origin feature/x --force",
  ]) {
    assertBlocked(run(command), /\[gate: push\]/, /force/i);
  }
});

test("6. a force push cannot be overridden", () => {
  assertBlocked(run("GML_GATE_SKIP=urgent git push -f origin feature/x"), /force/i);
  assertBlocked(run("git push -f origin feature/x", { env: { GML_GATE_SKIP: "urgent" } }), /force/i);
});

test("6. an explicit push to main or master is blocked", () => {
  for (const command of [
    "git push origin main",
    "git push origin master",
    "git push origin HEAD:main",
    "git push origin feature/x:main",
    "git push origin refs/heads/x:refs/heads/main",
    "git push -u origin main",
    "git push origin :main",
  ]) {
    assertBlocked(run(command), /\[gate: push\]/, /main|master/);
  }
});

test("6. a bare push is judged by the branch it would push", () => {
  assertBlocked(run("git push", { cwd: sandbox({ branch: "main" }) }), /\[gate: push\]/, /main/);
  assertAllowed(run("git push", { cwd: sandbox({ branch: "feature/x" }) }));
});

test("6. pushing a feature branch is allowed", () => {
  for (const command of ["git push origin feature/x", "git push -u origin chore/enforcement"]) {
    assertAllowed(run(command));
  }
  // No refspec, so the target is the current branch — asserted in a sandbox
  // rather than against ROOT, whose branch is whatever the run happens to be on.
  assertAllowed(run("git push --tags origin", { cwd: sandbox({ branch: "feature/x" }) }));
});

/**
 * An environment whose PATH begins with `dir/bin`, with the parent's own PATH
 * removed rather than shadowed.
 *
 * Windows reports the variable as `Path`, and an env object carrying both `Path`
 * and `PATH` is ambiguous — so every spelling is dropped before the one this
 * test wants is set. A "gh is missing" test that quietly inherited the real
 * gh (2.87.3 IS installed on this machine) would assert nothing.
 */
function envWithPath(binDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== "path") env[k] = v;
  }
  env.PATH = binDir;
  return env;
}

/**
 * A stub `gh` that prints `json` for any arguments.
 *
 * Shipped as BOTH `gh.cmd` and a `gh` shell script because the hook must reach
 * it the way it reaches the real thing. Node 22 refuses to spawn a .cmd without
 * a shell (the 2024 argument-injection fix), and a real gh on Windows can itself
 * be a .cmd shim — which is why the hook spawns gh through a shell there, and
 * why this stub is resolvable that way.
 */
function stubGh(dir, json) {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (json !== null) {
    writeFileSync(join(binDir, "gh.cmd"), `@echo off\r\necho ${json}\r\n`);
    writeFileSync(join(binDir, "gh"), `#!/bin/sh\necho '${json}'\n`, { mode: 0o755 });
  }
  return envWithPath(binDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. MERGE ONLY WITH REVIEW
// ─────────────────────────────────────────────────────────────────────────────

test("7. gh pr merge --admin is blocked", () => {
  const dir = sandbox();
  for (const command of ["gh pr merge 42 --admin --squash", "gh pr merge --admin"]) {
    assertBlocked(run(command, { cwd: dir, env: stubGh(dir, '{"body":"Review-Verdict: approved"}') }), /--admin/);
  }
});

test("7. a merge is blocked when the PR body carries no approved verdict", () => {
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"Looks fine to me, merging"}');
  assertBlocked(run("gh pr merge 42 --squash", { cwd: dir, env }), /Review-Verdict: approved/);
});

test("7. a merge is allowed when the PR body carries the approved verdict", () => {
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"## Summary ... Review-Verdict: approved"}');
  assertAllowed(run("gh pr merge 42 --squash", { cwd: dir, env }));
  // No PR number: gh resolves the PR from the current branch.
  assertAllowed(run("gh pr merge --squash", { cwd: dir, env }));
});

test("7. an unreachable gh is a refusal, not a free pass", () => {
  // The failure mode worth naming: a gate that treats "could not check" as
  // "fine" is off precisely when the tooling is broken.
  const dir = sandbox();
  assertBlocked(run("gh pr merge 42 --squash", { cwd: dir, env: stubGh(dir, null) }), /gh/, /could not/i);
});

test("7. the merge rule cannot be overridden", () => {
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"no verdict here"}');
  assertBlocked(run("GML_GATE_SKIP=urgent gh pr merge 42 --squash", { cwd: dir, env }), /Review-Verdict/);
  assertBlocked(run("gh pr merge 42 --admin", { cwd: dir, env: { ...env, GML_GATE_SKIP: "urgent" } }), /--admin/);
});

test("7. other gh commands are not the merge gate's business", () => {
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"no verdict"}');
  for (const command of ["gh pr view 42", "gh pr create --fill", "gh pr checks 42"]) {
    assertAllowed(run(command, { cwd: dir, env }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. WORKTREES ONLY UNDER .worktrees/
// ─────────────────────────────────────────────────────────────────────────────

/** A sandbox whose .gitignore covers .worktrees/, as this repo's does. */
function ignoringSandbox() {
  return sandbox({ files: { ".gitignore": ".worktrees/\nworkspace/\n" } });
}

test("8. a worktree outside .worktrees/ is blocked", () => {
  const dir = ignoringSandbox();
  for (const command of [
    "git worktree add ../enforcement -b chore/enforcement",
    "git worktree add /tmp/scratch",
    "git worktree add wt/foo -b foo",
    "git worktree add -b foo ../foo",
  ]) {
    assertBlocked(run(command, { cwd: dir }), /\[gate: worktree\]/, /\.worktrees\//);
  }
});

test("8. a worktree under .worktrees/ is allowed, in a sandbox and in this repo", () => {
  const dir = ignoringSandbox();
  assertAllowed(run("git worktree add .worktrees/foo -b foo", { cwd: dir }));
  // The path can come after the flags, and -b consumes its own value.
  assertAllowed(run("git worktree add -b foo .worktrees/foo", { cwd: dir }));
  // The real repository: .gitignore line 45 is `.worktrees/`.
  assertAllowed(run("git worktree add .worktrees/review -b chore/review"));
});

test("8. an un-ignored .worktrees/ is blocked, because the worktree would be committable", () => {
  // A worktree that git does not ignore gets its whole checkout staged by the
  // next `git add -A`. The path rule alone would pass this; the check-ignore
  // requirement is what makes it a real guarantee.
  const dir = sandbox(); // no .gitignore at all
  assertBlocked(run("git worktree add .worktrees/foo -b foo", { cwd: dir }), /check-ignore|gitignore/i);
});

test("8. the worktree rule cannot be overridden", () => {
  const dir = ignoringSandbox();
  assertBlocked(run("GML_GATE_SKIP=urgent git worktree add ../foo -b foo", { cwd: dir }), /\.worktrees\//);
});

test("8. other worktree subcommands are not the path gate's business", () => {
  const dir = ignoringSandbox();
  for (const command of ["git worktree list", "git worktree prune", "git worktree repair"]) {
    assertAllowed(run(command, { cwd: dir }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. A HOOK MUST NEVER CRASH, AND MUST NEVER BLOCK BY ACCIDENT
// ─────────────────────────────────────────────────────────────────────────────

/** Spawn with a raw stdin string, bypassing the JSON the other tests send. */
function runRaw(input, { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd, encoding: "utf8", timeout: 20_000, input,
    env: { ...process.env, GML_GATE_SKIP: "", ...env },
  });
  if (r.error) assert.fail(`could not spawn ${HOOK}: ${r.error.message}`);
  return r;
}

test("9. malformed or empty payloads are allowed, not crashed on", () => {
  // Exit 1 is a CRASH, and a crashing PreToolUse hook blocks nothing while
  // filling the transcript with stack traces. Exit 2 here would be worse: it
  // would block every Bash call in the session.
  for (const input of ["", "   ", "not json at all", "null", "[]", "{}", '{"tool_input":null}']) {
    const r = runRaw(input);
    assert.equal(r.status, 0, `payload ${JSON.stringify(input)} → exit ${r.status}: ${r.stderr}`);
  }
});

test("9. a non-Bash tool is none of this hook's business", () => {
  const r = runRaw(JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "x.ts", new_string: "rm -rf /" },
  }));
  assert.equal(r.status, 0, `expected exit 0; got ${r.status}: ${r.stderr}`);
});

test("9. odd command shapes do not throw", () => {
  for (const command of [
    "",
    "   \n  \n ",
    "&&",
    "|||",
    "git",
    "git -C",
    "git worktree add",
    "git push --repo",
    "rm",
    "cat <<'EOF'\nunterminated heredoc",
    "x".repeat(50_000),
  ]) {
    const r = run(command);
    assert.ok(r.status === 0 || r.status === 2, `command ${JSON.stringify(command.slice(0, 20))} → exit ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /at Object\.|node:internal/, "a stack trace reached stderr");
  }
});

test("9. a repo git cannot read is allowed through rather than blocking everything", () => {
  // git missing from PATH must not turn every Bash call into a refusal. The
  // gate degrades to the commands it can judge without git.
  const dir = sandbox();
  const env = envWithPath(join(dir, "empty-bin"));
  mkdirSync(join(dir, "empty-bin"), { recursive: true });
  assertAllowed(run("ls -la", { cwd: dir, env }));
  assertBlocked(run("rm -rf x", { cwd: dir, env }), /destructive/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. FAST ENOUGH TO RUN ON EVERY TOOL CALL
// ─────────────────────────────────────────────────────────────────────────────

test("10. the common case costs nothing worth noticing", () => {
  // This runs before EVERY Bash call, so the budget is the whole spawn —
  // node's own startup included, since that is what the user actually waits for.
  const commands = ["ls -la", "pnpm test", "node --test tests/hooks/pre-bash.test.mjs", "cat package.json"];
  const started = Date.now();
  for (const command of commands) assertAllowed(run(command));
  const each = (Date.now() - started) / commands.length;
  assert.ok(each < 1000, `${each.toFixed(0)}ms per allowed command — too slow for every tool call`);
});
