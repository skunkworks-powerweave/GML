// Spawn tests for the two PostToolUse hooks.
//
// These drive the hooks exactly the way Claude Code does — a child process,
// the payload as JSON on STDIN — because the previous generation of hooks in
// this project was written against a contract that did not exist ($TOOL_INPUT,
// pathGlob) and nothing ever noticed: workspace/session_log.md sat at 112 bytes
// through 27 commits. A test that imported the hook's functions directly would
// have passed just as happily. Only the process boundary proves anything.
//
// Nothing here touches the real repository. Each test builds a throwaway repo
// in a temp directory and copies the hooks into <tmp>/.claude/hooks/, which is
// what makes _lib.mjs's PROJECT_DIR (resolved from the hook's OWN location)
// point at the fixture instead of at D:/GML/lms-app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOKS = resolve(ROOT, ".claude", "hooks");
const MIG = "packages/db/src/migrations";

const temps = [];
process.on("exit", () => {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best effort: a leaked temp dir must never fail the suite.
    }
  }
});

/** A throwaway repo with the hooks installed at <tmp>/.claude/hooks/. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gml-posthook-"));
  temps.push(dir);
  mkdirSync(resolve(dir, ".claude", "hooks"), { recursive: true });
  for (const f of ["_lib.mjs", "post-edit.mjs", "post-bash.mjs"]) {
    const src = resolve(HOOKS, f);
    if (existsSync(src)) copyFileSync(src, resolve(dir, ".claude", "hooks", f));
  }
  return dir;
}

function put(dir, rel, content) {
  const p = resolve(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** A _journal.json listing exactly the tags given. */
function journal(dir, tags) {
  put(
    dir,
    `${MIG}/meta/_journal.json`,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: tags.map((tag, idx) => ({
        idx,
        version: "7",
        when: 1780000000000 + idx,
        tag,
        breakpoints: true,
      })),
    }),
  );
}

function runEdit(dir, filePath, toolName = "Edit") {
  return spawnSync(
    process.execPath,
    [resolve(dir, ".claude", "hooks", "post-edit.mjs")],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_input: { file_path: filePath },
      }),
    },
  );
}

/** The additionalContext a hook fed back, or "" when it stayed silent. */
function said(r) {
  if (!r.stdout || !r.stdout.trim()) return "";
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return `<unparseable stdout: ${r.stdout}>`;
  }
}

// ── post-edit.mjs ───────────────────────────────────────────────────────────

test("post-edit: says nothing about a file that is not a migration", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  const f = put(dir, "apps/web/src/app/page.tsx", "export default function P() {}\n");
  const r = runEdit(dir, f);
  assert.equal(r.status, 0, `hook must exit 0; stderr=${r.stderr}`);
  assert.equal(said(r), "", "an ordinary source edit must not be commented on");
});

test("post-edit: flags a numbered migration missing from _journal.json", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  const f = put(dir, `${MIG}/0001_add_widgets.sql`, "CREATE TABLE widgets (id int);\n");
  const r = runEdit(dir, f);
  assert.equal(r.status, 0, `PostToolUse must never block; stderr=${r.stderr}`);
  const msg = said(r);
  assert.match(msg, /_journal\.json/, "must name the journal that is missing the tag");
  assert.match(msg, /0001_add_widgets/, "must name the migration tag");
});

test("post-edit: stays silent when the tag IS in the journal", () => {
  const dir = fixture();
  journal(dir, ["0000_base", "0001_add_widgets"]);
  const f = put(dir, `${MIG}/0001_add_widgets.sql`, "CREATE TABLE widgets (id int);\n");
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "a journalled, otherwise clean migration needs no comment");
});

test("post-edit: flags CREATE INDEX CONCURRENTLY inside a numbered migration", () => {
  const dir = fixture();
  journal(dir, ["0001_add_widgets"]);
  const f = put(
    dir,
    `${MIG}/0001_add_widgets.sql`,
    "CREATE INDEX CONCURRENTLY widgets_name_idx ON widgets (name);\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  const msg = said(r);
  assert.match(msg, /CONCURRENTLY/, "must name the offending construct");
  assert.match(
    msg,
    /transaction|BEGIN/i,
    "must explain that the runner wraps each file in a transaction",
  );
  assert.match(msg, /_post/, "must point at migrations/_post as the way forward");
});

test("post-edit: does not flag CONCURRENTLY that only appears in a comment", () => {
  const dir = fixture();
  journal(dir, ["0001_add_widgets"]);
  const f = put(
    dir,
    `${MIG}/0001_add_widgets.sql`,
    "-- deliberately NOT create index concurrently: see migrate.ts\n" +
      "CREATE INDEX widgets_name_idx ON widgets (name);\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "a comment mentioning the construct is not a defect");
});

test("post-edit: flags DROP TABLE with no `-- irreversible:` note", () => {
  const dir = fixture();
  journal(dir, ["0002_drop_widgets"]);
  const f = put(dir, `${MIG}/0002_drop_widgets.sql`, "DROP TABLE widgets;\n");
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  const msg = said(r);
  assert.match(msg, /DROP TABLE/i, "must name the destructive statement");
  assert.match(msg, /-- irreversible:/, "must name the exact line it wants");
});

test("post-edit: flags DROP COLUMN with no `-- irreversible:` note", () => {
  const dir = fixture();
  journal(dir, ["0003_trim_widgets"]);
  const f = put(
    dir,
    `${MIG}/0003_trim_widgets.sql`,
    "ALTER TABLE widgets DROP COLUMN legacy_name;\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  assert.match(said(r), /DROP COLUMN/i, "must name the destructive statement");
});

test("post-edit: accepts a DROP that carries an `-- irreversible:` note", () => {
  const dir = fixture();
  journal(dir, ["0002_drop_widgets"]);
  const f = put(
    dir,
    `${MIG}/0002_drop_widgets.sql`,
    "-- irreversible: widgets was superseded by gadgets in 0001 and has been\n" +
      "-- empty in production since; no backfill path exists or is wanted.\n" +
      "DROP TABLE widgets;\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "a documented irreversible migration is compliant");
});

test("post-edit: reports every problem in one pass, not just the first", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  const f = put(
    dir,
    `${MIG}/0009_messy.sql`,
    "DROP TABLE widgets;\nCREATE INDEX CONCURRENTLY g_idx ON gadgets (name);\n",
  );
  const r = runEdit(dir, f);
  const msg = said(r);
  // One round trip must surface all three defects; a hook that reports one at
  // a time turns a single bad migration into three edit/feedback cycles.
  assert.match(msg, /_journal\.json/);
  assert.match(msg, /CONCURRENTLY/);
  assert.match(msg, /-- irreversible:/);
});

test("post-edit: warns when a _post file declares an index the schema also declares", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  put(
    dir,
    "packages/db/src/schema/widgets.ts",
    'export const widgets = pgTable("widgets", {}, (t) => [\n' +
      '  index("widgets_name_idx").on(t.name),\n' +
      "]);\n",
  );
  const f = put(
    dir,
    `${MIG}/_post/007_widget_indexes.sql`,
    "CREATE INDEX IF NOT EXISTS widgets_name_idx ON widgets (name);\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  const msg = said(r);
  assert.match(msg, /widgets_name_idx/, "must name the object declared twice");
  assert.match(msg, /schema\/widgets\.ts/, "must name the schema file it collides with");
});

test("post-edit: leaves a _post file alone when the schema does not declare the object", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  put(
    dir,
    "packages/db/src/schema/widgets.ts",
    'export const widgets = pgTable("widgets", {});\n',
  );
  const f = put(
    dir,
    `${MIG}/_post/007_widget_indexes.sql`,
    "CREATE INDEX IF NOT EXISTS widgets_name_idx ON widgets (name);\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "a _post-only object is the whole point of the _post lane");
});

test("post-edit: does not apply the numbered-migration rules to _post files", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  // _post files are NOT journalled and routinely drop things; holding them to
  // the numbered-migration rules would make the hook wrong on every existing
  // file in that directory (003_supabase_identity.sql drops four tables).
  const f = put(
    dir,
    `${MIG}/_post/003_identity.sql`,
    "DROP TABLE IF EXISTS public.auth_sessions;\n",
  );
  const r = runEdit(dir, f);
  assert.equal(r.status, 0);
  assert.equal(said(r), "");
});

test("post-edit: survives a file that no longer exists on disk", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  // Claude can Write a file and something else can remove it before the hook
  // runs. A throw here would print a stack trace after every edit in the repo,
  // and the fix everyone reaches for is deleting the hook.
  const r = runEdit(dir, resolve(dir, `${MIG}/0042_vanished.sql`));
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr ?? "", /Error|at .*\.mjs/, "no stack trace");
});

test("post-edit: survives empty and malformed stdin", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  const hook = resolve(dir, ".claude", "hooks", "post-edit.mjs");
  for (const input of ["", "not json at all", "{}", '{"tool_input":null}']) {
    const r = spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input,
    });
    assert.equal(r.status, 0, `input ${JSON.stringify(input)}: stderr=${r.stderr}`);
  }
});

test("post-edit: ignores tool events that are not edits", () => {
  const dir = fixture();
  journal(dir, ["0000_base"]);
  const f = put(dir, `${MIG}/0001_add_widgets.sql`, "DROP TABLE widgets;\n");
  const r = runEdit(dir, f, "Bash");
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "settings.json scoping is not trustworthy; scope here too");
});

test("post-edit: finishes fast enough to run on every edit", () => {
  const dir = fixture();
  journal(dir, ["0001_add_widgets"]);
  const f = put(dir, `${MIG}/0001_add_widgets.sql`, "CREATE TABLE widgets (id int);\n");
  const started = Date.now();
  runEdit(dir, f);
  const ms = Date.now() - started;
  // Generous: this is a whole node process start. It exists to catch a future
  // change that shells out to git or the database from an edit hook.
  assert.ok(ms < 2000, `post-edit took ${ms}ms; it runs on every single edit`);
});

// ── post-bash.mjs ───────────────────────────────────────────────────────────

const SNAPSHOT = "workspace/.status-snapshot";

/** A fixture that is a real (empty) git repo, so `git status` has something to say. */
function gitFixture() {
  const dir = fixture();
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
}

/** What pre-bash.mjs records before the Bash call: `git status --porcelain`. */
function snapshot(dir, lines) {
  put(dir, SNAPSHOT, lines.length ? `${lines.join("\n")}\n` : "");
}

function runBash(dir, command = "echo hi") {
  return spawnSync(
    process.execPath,
    [resolve(dir, ".claude", "hooks", "post-bash.mjs")],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    },
  );
}

test("post-bash: says nothing when pre-bash has written no snapshot yet", () => {
  const dir = gitFixture();
  put(dir, "apps/web/src/lib/new.ts", "export const x = 1;\n");
  const r = runBash(dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(said(r), "", "a missing snapshot must be silent, not noisy or fatal");
});

test("post-bash: flags a new source file that arrived with no test change", () => {
  const dir = gitFixture();
  snapshot(dir, []);
  put(dir, "apps/web/src/lib/signing.ts", "export const sign = () => {};\n");
  const r = runBash(dir, "cat > apps/web/src/lib/signing.ts <<'EOF'\n...\nEOF");
  assert.equal(r.status, 0, `PostToolUse must never block; stderr=${r.stderr}`);
  const msg = said(r);
  assert.match(msg, /apps\/web\/src\/lib\/signing\.ts/, "must name the file");
  assert.match(msg, /test/i, "must say what is missing");
});

test("post-bash: stays silent when a test changed alongside the source", () => {
  const dir = gitFixture();
  snapshot(dir, []);
  put(dir, "packages/db/src/queue.ts", "export const q = 1;\n");
  put(dir, "tests/behaviour/queue.test.ts", "// covers queue.ts\n");
  const r = runBash(dir);
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "source plus a test is exactly the discipline");
});

test("post-bash: stays silent when the Bash call changed nothing", () => {
  const dir = gitFixture();
  put(dir, "apps/web/src/lib/signing.ts", "export const sign = () => {};\n");
  // Snapshot taken AFTER the file exists: the Bash call added nothing new.
  snapshot(dir, ["?? apps/"]);
  const r = runBash(dir, "pnpm test");
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "a read-only Bash call must never be commented on");
});

test("post-bash: ignores changes outside apps/**/src and packages/**/src", () => {
  const dir = gitFixture();
  snapshot(dir, []);
  put(dir, "docs/architecture.md", "# notes\n");
  put(dir, "packages/db/drizzle.config.ts", "export default {};\n");
  const r = runBash(dir);
  assert.equal(r.status, 0);
  assert.equal(said(r), "", "docs and config are not the test-first rule's subject");
});

test("post-bash: survives a directory that is not a git repository", () => {
  const dir = fixture(); // deliberately NOT git init
  snapshot(dir, []);
  put(dir, "apps/web/src/lib/signing.ts", "export const sign = () => {};\n");
  const r = runBash(dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr ?? "", /at .*\.mjs/, "no stack trace");
});

test("post-bash: survives empty and malformed stdin", () => {
  const dir = gitFixture();
  snapshot(dir, []);
  const hook = resolve(dir, ".claude", "hooks", "post-bash.mjs");
  for (const input of ["", "not json at all", "{}"]) {
    const r = spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input,
    });
    assert.equal(r.status, 0, `input ${JSON.stringify(input)}: stderr=${r.stderr}`);
  }
});

test("post-bash: expands a snapshot's collapsed untracked directory", () => {
  const dir = gitFixture();
  put(dir, "apps/web/src/lib/old.ts", "export const a = 1;\n");
  // Plain `git status --porcelain` — what pre-bash writes — collapses an
  // untracked tree to one `?? apps/` line. Diffing that against a per-file
  // listing would report every pre-existing file as brand new, which is how
  // this hook would have become 100% noise and been switched off in a week.
  snapshot(dir, ["?? apps/"]);
  put(dir, "packages/db/src/new.ts", "export const b = 2;\n");
  const r = runBash(dir);
  const msg = said(r);
  assert.match(msg, /packages\/db\/src\/new\.ts/, "the genuinely new file is named");
  assert.doesNotMatch(msg, /old\.ts/, "a file the snapshot already covered is not");
});

test("post-bash: names every new source file, not just the first", () => {
  const dir = gitFixture();
  snapshot(dir, []);
  put(dir, "apps/web/src/a.ts", "export const a = 1;\n");
  put(dir, "packages/shared/src/b.ts", "export const b = 2;\n");
  const r = runBash(dir);
  const msg = said(r);
  assert.match(msg, /apps\/web\/src\/a\.ts/);
  assert.match(msg, /packages\/shared\/src\/b\.ts/);
});

test("post-bash: finishes fast enough to run on every Bash call", () => {
  const dir = gitFixture();
  snapshot(dir, []);
  put(dir, "apps/web/src/a.ts", "export const a = 1;\n");
  const started = Date.now();
  runBash(dir);
  const ms = Date.now() - started;
  // This one does shell out to git, so the budget is looser than post-edit's;
  // it is here to catch a future change that runs tests or reaches the database.
  assert.ok(ms < 3000, `post-bash took ${ms}ms; it runs on every Bash call`);
});

// ── calibration ─────────────────────────────────────────────────────────────
//
// These pin decisions rather than new behaviour, so they were green the moment
// they were written. They are here because each records a judgement that a
// later edit could silently reverse.

test("post-edit: a prose rationale is not a substitute for the marker", () => {
  const dir = fixture();
  journal(dir, ["0025_drop_bull_job_id"]);
  // This is the shape of the one real file in the repo that trips this rule:
  // packages/db/src/migrations/0025_drop_bull_job_id.sql carries fifteen lines
  // explaining the drop and no `-- irreversible:` line. The marker is required
  // anyway, deliberately — "does this comment count as a justification?" is not
  // a question a hook can answer, and a rule that guesses is a rule nobody can
  // satisfy on purpose.
  const f = put(
    dir,
    `${MIG}/0025_drop_bull_job_id.sql`,
    "-- Drop transcode_jobs.bull_job_id.\n" +
      "--\n" +
      "-- The column held a BullMQ job id. BullMQ is gone, replaced by the `jobs`\n" +
      "-- table, so nothing can write it.\n" +
      'ALTER TABLE "transcode_jobs" DROP COLUMN IF EXISTS "bull_job_id";\n',
  );
  const r = runEdit(dir, f);
  assert.match(said(r), /-- irreversible:/, "the marker is what is checked, not prose");
});

test("post-edit: says nothing when _journal.json is absent or malformed", () => {
  for (const journalText of [null, "{ not json", '{"entries":"nope"}']) {
    const dir = fixture();
    if (journalText !== null) put(dir, `${MIG}/meta/_journal.json`, journalText);
    const f = put(dir, `${MIG}/0001_add_widgets.sql`, "CREATE TABLE widgets (id int);\n");
    const r = runEdit(dir, f);
    assert.equal(r.status, 0, `journal=${journalText}: stderr=${r.stderr}`);
    // An unreadable journal is a different problem from an unjournalled
    // migration, and guessing which one it is would make the hook lie.
    assert.equal(said(r), "", `journal=${journalText} must not be reported as missing tag`);
  }
});

test("both hooks: every message names a way forward, never just a complaint", () => {
  const dir = gitFixture();
  journal(dir, ["0000_base"]);
  const bad = put(dir, `${MIG}/0009_messy.sql`, "DROP TABLE widgets;\n");
  snapshot(dir, []);
  put(dir, "apps/web/src/a.ts", "export const a = 1;\n");
  for (const [who, msg] of [
    ["post-edit", said(runEdit(dir, bad))],
    ["post-bash", said(runBash(dir))],
  ]) {
    assert.notEqual(msg, "", `${who} produced no message to check`);
    // A gate that only says "no" gets disabled wholesale the first time it is
    // wrong, so every message has to end somewhere the reader can act.
    assert.match(msg, /Way forward:/, `${who} must tell the reader what to do next`);
  }
});
