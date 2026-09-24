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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const head = headOf(dir);
  writeFileSync(
    join(dir, "workspace", "test-receipts.jsonl"),
    list.map((r) => `${JSON.stringify({ head, ...r })}\n`).join(""),
  );
}

/**
 * The sandbox's HEAD, or "" when it has no commits yet.
 *
 * C3(c): the gate now requires `receipt.head` to equal the current HEAD, so a
 * receipt forged here has to name the sandbox's real HEAD — and a sandbox with an
 * unborn HEAD has to claim "". Filling it in here rather than in receipt() means
 * a test that wants a MISMATCH has to say so out loud, and no test gets a green
 * receipt by accident.
 */
function headOf(dir) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : "";
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

/**
 * A receipt shaped exactly like the one scripts/test-gate.mjs appends.
 *
 * `head` is deliberately absent: writeReceipts() fills in the sandbox's real
 * HEAD unless a test overrides it. See headOf().
 */
function receipt(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    branch: "feature/x",
    treeHash: "unmatched".padEnd(64, "0"),
    suites: [{ suite: "governance", ran: true, status: 0, passed: 10, failed: 0, failing: [] }],
    exitCode: 0,
    noDb: false,
    ...overrides,
  };
}

// ─── rule 0: .env, written through a shell ───────────────────────────────────
//
// pre-edit.mjs has refused an Edit or Write to `.env` since it was written, and
// its refusal has no override. The SHELL spellings of the same write were all
// allowed — measured, eighteen of them — so the protection held for one tool and
// not for the tool beside it. The project's standing rule is that `.env` is
// never touched by the agent and never staged.

test("0. a shell redirection into .env is refused", () => {
  for (const command of [
    "echo SECRET=1 > .env",
    "echo SECRET=1 >> .env",
    "echo x >.env",
    'printf x > ".env"',
    "node build.js 2> .env",
    "pnpm build && echo x > .env",
    "echo x > .env.production",
    "echo x > .ENV",
    "echo x > apps/../.env",
  ]) {
    assertBlocked(run(command), /protected file/i, /\.env/);
  }
});

test("0. the NTFS spellings of .env are the same file here too", () => {
  // `.env::$DATA` is the default data stream of `.env` — the same bytes under a
  // different name. pre-edit.mjs normalises it; this rule has to agree, or the
  // two halves of one protection disagree about what a file is.
  assertBlocked(run("echo x > '.env::$DATA'"), /protected file/i);
});

test("0. the file-writing programs are refused too, in both sed spellings", () => {
  for (const command of [
    "echo x | tee .env",
    "echo x | tee -a .env",
    "sed -i s/a/b/ .env",
    "sed --in-place s/a/b/ .env",
    "mv tmp.txt .env",
    "cp other.env .env",
    "dd if=/dev/zero of=.env",
    "truncate -s 0 .env",
  ]) {
    assertBlocked(run(command), /protected file/i);
  }
});

test("0. reading .env is untouched, and .env.example stays writable", () => {
  // A rule that blocked reads would be worked around within the hour, and
  // .env.example is the committed, non-secret file the refusal points people at
  // — refusing it would make the way forward contradict the rule.
  for (const command of [
    "cat .env",
    "grep DATABASE_URL .env",
    "source .env",
    "echo X= > .env.example",
    "echo X= > .env.EXAMPLE",
    "cp .env.example /tmp/x",
    "pnpm build > build.log",
    "mv a.txt b.txt",
    "sed -i s/a/b/ README.md",
    "echo x | tee out.txt",
    "echo 'see .env for details'",
  ]) {
    assertAllowed(run(command));
  }
});

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

// ── C4: A ONE-TOKEN PREFIX DEFEATED EVERY RULE ───────────────────────────────
//
// argvOf() consumed `VAR=value` and `sudo` and nothing else, so the program name
// of `env rm -rf build` was `env` and no rule looked past it. Every command in
// the next three tests was VERIFIED ALLOWED (exit 0) before the fix.

test("1. C4: a one-token prefix does not hide a destructive command", () => {
  for (const command of [
    "env rm -rf build",
    "env -i FOO=1 rm -rf build",
    "env DATABASE_URL=x rm -rf build",
    "command rm -rf build",
    "command -p rm -rf build",
    "builtin rm -rf build",
    "nice rm -rf build",
    "nice -n 10 rm -rf build",
    "nice -10 rm -rf build",
    "ionice -c 3 rm -rf build",
    "time rm -rf build",
    "nohup rm -rf build",
    "setsid rm -rf build",
    "exec rm -rf build",
    "exec -a innocent rm -rf build",
    "doas rm -rf build",
    "doas -u root rm -rf build",
    "sudo -u root rm -rf build",
    "timeout 5 rm -rf build",
    "timeout -k 5 10s rm -rf build",
    "stdbuf -oL rm -rf build",
    "env docker volume rm gml_pgdata",
    "sudo env nice -n 5 rm -rf build",
    "find . -name '*.log' | xargs rm -rf",
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. C4: leading shell keywords and grouping do not hide one either", () => {
  // segments() already splits on `;`, so the rm in `if true; then rm -rf x; fi`
  // arrives as the segment "then rm -rf x" — with a keyword where the program
  // name should be.
  for (const command of [
    "if true; then rm -rf x; fi",
    "if [ -d x ]; then rm -rf x; else echo no; fi",
    "for f in a b; do rm -rf $f; done",
    "while read f; do rm -rf $f; done",
    "until false; do rm -rf x; done",
    "{ rm -rf x; }",
    "(rm -rf x)",
    "( rm -rf x )",
    "! rm -rf x",
    "case $x in a) rm -rf x;; esac",
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. C4: a quoted program name is the same program", () => {
  // `"rm"` is how you spell rm when you want to break a token match. program()
  // stripped a directory prefix and a .exe suffix but never the quotes.
  for (const command of ['"rm" -rf x', "'rm' -rf x", '"/usr/bin/rm" -rf x', "'git' reset --hard", '"docker" volume rm v']) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. C4: -R is a documented synonym for -r, so rm -Rf is rm -rf", () => {
  for (const command of [
    "rm -Rf build",
    "rm -R -f build",
    "rm -fR build",
    "rm --recursive --force build",
    "rm -R --force build",
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

// ─── N1 · N2 · N3: three more ways to spell a command the gate could not read ─
//
// Every one of these was ALLOWED by the commit that closed C1-C6, and every one
// of them was verified against a real bash before being written down: the
// continuation payloads really deleted a directory and really landed a commit on
// main, and the `$'…'` payloads really ran rm.
//
// A single backslash is easy to lose — a heredoc in this session ate one level
// of backslash four separate times — so the payloads are built from an explicit
// BS constant rather than written as escapes inside escapes. A test whose
// payload is not the payload it appears to be is worse than no test.
const BS = String.fromCharCode(92);
const NL = "\n";

test("1. N1: a line continuation is not a command boundary", () => {
  // `rm \<newline>-rf x` is ONE command in bash. segments() split on the newline
  // and saw `rm` and `-rf x`, neither of which is a rule violation on its own.
  for (const command of [
    `rm ${BS}${NL}  -rf node_modules`,
    `rm -rf ${BS}${NL} node_modules`,
    `docker ${BS}${NL} volume prune`,
    `docker compose ${BS}${NL} down -v`,
    `git ${BS}${NL} reset --hard HEAD~1`,
    // three backslashes: odd, so the last one still eats the newline
    `rm ${BS}${BS}${BS}${NL} -rf node_modules`,
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. N1: an EVEN run of backslashes leaves the newline a boundary", () => {
  // `echo a\\` is an escaped backslash and then the command ENDS. Joining here
  // would pull the next command into the first one's arguments and hide it —
  // so the following rm must still be seen as its own command.
  assertBlocked(run(`echo a${BS}${BS}${NL}rm -rf node_modules`), /destructive/i);
  // ...and the same shape with a harmless second command must still pass, which
  // is what proves the line above is not passing for the wrong reason.
  assertAllowed(run(`echo a${BS}${BS}${NL}ls -la`));
});

test("1. N1: a continuation inside SQL is joined before the pattern runs", () => {
  // `\s` does not match a backslash, so `DROP \<newline>TABLE` matched nothing
  // — while bash removes the backslash-newline before psql sees the string.
  assertBlocked(run(`psql -c "DROP ${BS}${NL} TABLE users"`), /DROP TABLE/i);
});

test("1. N1: an ordinary multi-line command still passes", () => {
  // The rule must not turn every wrapped shell line into a refusal: this is how
  // half the commands in this project's docs are written.
  assertAllowed(run(`pnpm ${BS}${NL}  install --frozen-lockfile`));
  assertAllowed(run(`docker run ${BS}${NL} --rm ${BS}${NL} gml-worker:ci ffmpeg -version`));
});

test("1. N2: ANSI-C quoting is the same program", () => {
  // `$'rm'` is `rm`. The old unquote() took one character off each end, so it
  // produced `$'rm` — the name of nothing, matching no rule.
  for (const command of [
    `$'rm' -rf node_modules`,
    `$"rm" -rf node_modules`,
    `$'${BS}x72m' -rf node_modules`, // \x72 is 'r'
    `$'${BS}162m' -rf node_modules`, // octal 162 is 'r'
    `$'${BS}u0072m' -rf node_modules`,
    `$'docker' volume prune`,
    `$'git' reset --hard`,
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. N2: a backslash inside a word is an escape, not a character", () => {
  // `r\m` is `rm` in bash. The old path happened to get `\rm` right — the
  // directory-prefix strip removed it by accident — and got `r\m` wrong.
  for (const command of [
    `r${BS}m -rf node_modules`,
    `${BS}rm -rf node_modules`,
    `'r'm -rf node_modules`,
    `r'm' -rf node_modules`,
    `r${BS}m${BS} -rf node_modules`,
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("1. N2: a quoted Windows path still resolves to its program", () => {
  // The other direction of the same change. Inside double quotes a backslash is
  // literal unless it precedes $ ` " \ or newline, so the separators survive and
  // the basename is still the program — while the UNQUOTED spelling is not this
  // program in a real shell either, and is not claimed to be.
  assertBlocked(run(`"C:${BS}Users${BS}bin${BS}git.exe" reset --hard`), /destructive/i);
  assertBlocked(run(`'C:${BS}Users${BS}bin${BS}rm.exe' -rf node_modules`), /destructive/i);
});

test("3. N3: a docker global flag does not move the command group", () => {
  // pre-bash read argv[1] as the group, which is the I2 mistake that was fixed
  // for `gh` and left standing for docker. `-H` and `--context` are the sharp
  // ones: they aim the command at a DIFFERENT daemon.
  for (const command of [
    "docker -D volume prune",
    "docker --debug volume prune",
    "docker --context prod volume rm pgdata",
    "docker --context=prod volume rm pgdata",
    "docker -H tcp://10.0.0.1:2375 volume rm pgdata",
    "docker --tls compose down -v",
    "docker -l debug compose down --volumes",
    "docker -D system prune -a --volumes",
    "docker --config /tmp/cfg volume prune",
  ]) {
    assertBlocked(run(command), /destructive/i);
  }
});

test("3. N3: docker's harmless commands still pass, flags or not", () => {
  for (const command of [
    "docker ps",
    "docker -D ps",
    "docker compose up -d",
    "docker compose down",
    "docker --context prod compose up -d",
    "docker compose -f docker-compose.yml up -d --build",
  ]) {
    assertAllowed(run(command));
  }
});

// ── C5: TWO CHARACTERS HID ANYTHING AFTER THEM ───────────────────────────────

test("1. C5: a heredoc opener only counts in redirection position", () => {
  // VERIFIED in real bash: `N=3; echo $((1<<N))` prints 8 and the NEXT line
  // RUNS. stripHeredocs read `<<N` as an opener, found no line equal to `N`, and
  // discarded everything to the end of input — so the rm was never scanned and
  // the gate returned 0.
  assertBlocked(run("echo $((1<<N))\nrm -rf node_modules"), /destructive/i);
  assertBlocked(run("echo $(( 1 << SHIFT ))\ngit reset --hard"), /destructive/i);
  assertBlocked(run("echo $(( (1+2)<<3 ))\nrm -rf node_modules"), /destructive/i);
  assertBlocked(run("(( x = 1<<2 ))\nrm -rf node_modules"), /destructive/i);
  assertBlocked(run("# see cat <<EOF for the pattern\nrm -rf node_modules"), /destructive/i);
  assertBlocked(run("echo hi  # <<EOF\nrm -rf node_modules"), /destructive/i);
  // A here-STRING has no delimiter line to look for, so it opens no body.
  assertBlocked(run("grep x <<<'a'\nrm -rf node_modules"), /destructive/i);

  // ── AND THE SAME SHAPES WITH THE DELIMITER ACTUALLY PRESENT ────────────────
  // These matter more than the ones above. When the delimiter appears further
  // down, a loose opener FINDS it and drops only the lines in between, which is
  // how the bypass really worked. Without these, the "scan an unterminated
  // heredoc" half of the fix would cover for a still-loose opener and hide that
  // it was loose — so each payload below pins one specific guard:
  //   the arithmetic mask   →  $(( 1 << SHIFT ))
  //   the digit lookbehind  →  1<<N with no $(( )) around it
  //   the comment mask      →  # cat <<EOF
  //   the <<< exclusion     →  a here-string whose text also names a line below
  assertBlocked(run("echo $(( 1 << SHIFT ))\nrm -rf node_modules\nSHIFT"), /destructive/i);
  assertBlocked(run('echo "shift by 1<<N"\nrm -rf node_modules\nN'), /destructive/i);
  assertBlocked(run("# cat <<EOF\nrm -rf node_modules\nEOF"), /destructive/i);
  assertBlocked(run("grep x <<<'a'\nrm -rf node_modules\na"), /destructive/i);
});

test("1. C5: an unterminated heredoc does not swallow the rest of the input", () => {
  // The other half of C5: with no closing delimiter the loop ran to
  // lines.length and dropped every remaining line, so LEAVING THE DELIMITER OFF
  // was itself a universal bypass.
  assertBlocked(run("cat <<'EOF'\nrm -rf node_modules"), /destructive/i);
  assertBlocked(run("cat <<EOF > f.txt\ngit reset --hard"), /destructive/i);
});

test("1. C5: a TERMINATED heredoc body is still data, not a command", () => {
  // The reason stripHeredocs exists at all, and the case the C5 fix must not
  // break: writing the WORDS "rm -rf" into a file runs nothing.
  assertAllowed(run("cat <<'EOF' > notes.md\nrm -rf node_modules\nEOF"));
  assertAllowed(run("cat <<EOF > notes.md\ngit reset --hard\nEOF"));
  assertAllowed(run("cat <<-EOF > notes.md\n\tdocker volume rm x\n\tEOF"));
  // Two bodies opened on one line close in the order they were opened.
  assertAllowed(run("cat <<A <<B > f\nrm -rf one\nA\nrm -rf two\nB"));
});

// ── I8: DENYLIST GAPS ────────────────────────────────────────────────────────

test("1. I8: the named denylist gaps are closed", () => {
  const cases = [
    ["psql \"$DATABASE_URL\" -c 'DROP SCHEMA public CASCADE'", /DROP SCHEMA/],
    ["psql \"$DATABASE_URL\" -c 'DELETE FROM audit_log'", /DELETE FROM/],
    ["psql \"$DATABASE_URL\" -c 'DELETE FROM users WHERE id = 1'", /DELETE FROM/],
    ["psql \"$DATABASE_URL\" -c 'ALTER TABLE users DROP COLUMN locale'", /DROP COLUMN/],
    ["docker volume prune -f", /docker volume prune/],
    ["docker system prune -a --volumes", /docker system prune/],
  ];
  for (const [command, mustMention] of cases) {
    assertBlocked(run(command), /destructive/i, mustMention);
  }
});

test("1. I8: a DELETE FROM inside a heredoc body is caught too", () => {
  // SQL is matched over the whole command text, heredoc bodies included, because
  // `psql <<'SQL'` is the only shape a statement actually arrives in here.
  assertBlocked(run("psql \"$DATABASE_URL\" <<'SQL'\nDELETE FROM submissions;\nSQL"), /DELETE FROM/);
});

test("1. I8: an ALTER TABLE with no DROP COLUMN is not refused", () => {
  // The rule is the PAIR, not the words. An additive column is not destructive
  // and a gate that refused it would be refusing the fix as well as the damage.
  assertAllowed(run("psql \"$DATABASE_URL\" -c 'ALTER TABLE users ADD COLUMN locale text'"));
  assertAllowed(run("echo 'we should DROP COLUMN only via a migration'"));
});

test("1. I8: the SQL prose over-match is deliberate, and it is pinned here", () => {
  // Written down rather than left to be discovered: DELETE FROM followed by an
  // identifier is refused even in prose, exactly as DROP TABLE already was. The
  // refusal has to print the way out, because that is the whole difference
  // between an over-match you can work with and one that gets the gate deleted.
  assertBlocked(run("echo 'never DELETE FROM a table without a WHERE'"), /DELETE FROM/, /Write tool/);
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

test("2. C4: grouping and keywords do not hide a commit either", () => {
  const dir = sandbox({ branch: "main" });
  for (const command of [
    "( git commit -m x )",
    "(git commit -m x)",
    "{ git commit -m x; }",
    "if true; then git commit -m x; fi",
    "'git' commit -m x",
    '"git" commit -m x',
    "env git commit -m x",
    "nohup git commit -m x",
    "time git commit -m x",
  ]) {
    assertBlocked(run(command, { cwd: dir }), /protected branch/i);
  }
});

test("2. I3: a commit redirected by --git-dir/--work-tree is out of scope", () => {
  // VERIFIED ALLOWED. gitInvocation() consumed `--git-dir=X` and `--work-tree=Y`
  // as noise and captured only -C, so this committed into a tree whose branch,
  // staged paths and receipt the gate had never read. The space-separated
  // spelling was worse still: the VALUE stayed in argv as a positional, so the
  // subcommand parsed as "/tmp/other/.git" and the commit gate did not run at
  // all — no scope check, no branch check, no receipt check.
  const dir = sandbox({ branch: "feature/x" });
  for (const command of [
    "git --git-dir=../elsewhere/.git --work-tree=../elsewhere commit -m x",
    "git --git-dir ../elsewhere/.git --work-tree ../elsewhere commit -m x",
    "git --work-tree=../elsewhere commit -m x",
    "git --work-tree ../elsewhere commit -m x",
    "git --git-dir=../elsewhere/.git commit -m x",
    "git --git-dir /tmp/other/.git commit -m x",
  ]) {
    assertBlocked(run(command, { cwd: dir }), /commit scope/i);
  }
});

test("2. I3: --git-dir/--work-tree naming THIS tree are not refused for scope", () => {
  // The rule is "somewhere else", not "these flags exist". A worktree's real git
  // directory lives outside its checkout, so the check has to accept the git dir
  // git itself reports as well as <repo>/.git.
  const dir = sandbox({ branch: "feature/x" });
  for (const command of ["git --work-tree=. commit -m x", "git --git-dir=.git commit -m x", "git --work-tree . --git-dir .git commit -m x"]) {
    const r = run(command, { cwd: dir });
    assert.doesNotMatch(r.stderr, /commit scope/i, `${command} was refused for scope: ${r.stderr}`);
    // It still has to reach the receipt rule — proof the commit was RECOGNISED
    // rather than parsed into something the gate stopped caring about.
    assertBlocked(r, /no test receipt/i);
  }
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

// ── C3(c): MAKING A FORGED RECEIPT A BIGGER LIE ──────────────────────────────
//
// The receipt is a plain file under workspace/, which pre-edit.mjs exempts, so
// anything that can write a file can write a receipt. That cannot be closed from
// inside this hook. What these tests pin is the next best thing: every field a
// forgery now has to get RIGHT, including two (head, treeHash) it does not choose.

test("3. C3(c): a receipt whose head is not this HEAD is not evidence", async () => {
  const dir = sandbox({ files: { "a.txt": "a\n" }, staged: ["a.txt"] });
  commitStagedViaPlumbing(dir);
  writeReceipts(dir, [
    receipt({ exitCode: 0, treeHash: await sandboxTreeHash(dir), head: "d".repeat(40) }),
  ]);
  const r = run("git commit -m x", { cwd: dir });
  assertBlocked(r, /commit evidence/i, /HEAD/);
});

test("3. C3(c): a receipt for this HEAD and this tree still passes", async () => {
  // The other side of the same check: adding a field to compare must not make
  // every honest receipt unusable.
  const dir = sandbox({ files: { "a.txt": "a\n" }, staged: ["a.txt"] });
  commitStagedViaPlumbing(dir);
  writeReceipts(dir, [receipt({ exitCode: 0, treeHash: await sandboxTreeHash(dir) })]);
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test("3. C3(c): a receipt where nothing ran is not green", async () => {
  for (const suites of [
    [],
    [{ suite: "behaviour", ran: false, reason: "no DATABASE_URL" }],
    [{ suite: "governance", ran: "true", status: 0, passed: 1, failed: 0 }],
  ]) {
    const dir = sandbox();
    writeReceipts(dir, [receipt({ exitCode: 0, suites, treeHash: await sandboxTreeHash(dir) })]);
    const r = run("git commit -m x", { cwd: dir });
    assertBlocked(r, /commit evidence/i, /no suite/i);
  }
});

test("3. C3(c): a receipt that contradicts itself is not green", async () => {
  // exitCode and the per-suite status are two separate fields in a file anyone
  // can write. scripts/test-gate.mjs takes exitCode from the WORST suite status,
  // so exitCode 0 beside a suite reporting status 1 is a shape it cannot produce.
  const dir = sandbox();
  writeReceipts(dir, [
    receipt({
      exitCode: 0,
      suites: [{ suite: "governance", ran: true, status: 1, passed: 8, failed: 2, failing: ["test_011 moat"] }],
      treeHash: await sandboxTreeHash(dir),
    }),
  ]);
  assertBlocked(run("git commit -m x", { cwd: dir }), /commit evidence/i, /contradict/i);
});

test("3. C3(c): a SKIPPED database suite beside a real one is still green", async () => {
  // The shape scripts/test-gate.mjs writes when DATABASE_URL is unset: one suite
  // ran, one recorded as ran:false. Demanding ran:true from EVERY entry would
  // refuse every commit made without a database — the noDb rule below is what
  // handles that case, and it handles it per staged path instead of wholesale.
  const dir = sandbox({ files: { "docs/x.md": "# x\n" }, staged: ["docs/x.md"] });
  writeReceipts(dir, [
    receipt({
      exitCode: 0,
      noDb: true,
      suites: [
        { suite: "governance", ran: true, status: 0, passed: 10, failed: 0, failing: [] },
        { suite: "behaviour", ran: false, reason: "no DATABASE_URL" },
      ],
      treeHash: await sandboxTreeHash(dir),
    }),
  ]);
  assertAllowed(run("git commit -m x", { cwd: dir }));
});

test('3. C3(c): noDb as the STRING "true" is still noDb', async () => {
  // `receipt.noDb === true` is a strict compare and JSON read from a file is not
  // typed, so "true" passed straight through and a database-free receipt covered
  // a change to runtime code.
  for (const noDb of ["true", "TRUE", 1]) {
    const dir = sandbox({
      files: { "apps/web/src/page.tsx": "export const x = 1;\n", "tests/behaviour/p.test.ts": "// t\n" },
      staged: ["apps/web/src/page.tsx", "tests/behaviour/p.test.ts"],
    });
    writeReceipts(dir, [receipt({ exitCode: 0, noDb, treeHash: await sandboxTreeHash(dir) })]);
    assertBlocked(run("git commit -m x", { cwd: dir }), /without a database/i, /apps\/web/);
  }
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

// ── I1: PUSHES THAT REACHED main WITHOUT NAMING IT ───────────────────────────

test("6. I1: a refspec that RESOLVES to main is a push to main", () => {
  // VERIFIED ALLOWED. The target was the last `:`-separated field with
  // refs/heads/ stripped, so `HEAD`, `@` and `heads/main` came out as themselves,
  // matched nothing in PROTECTED_BRANCHES, and pushed main while standing on it.
  const onMain = sandbox({ branch: "main" });
  for (const command of [
    "git push origin HEAD",
    "git push origin @",
    "git push -u origin HEAD",
    "git push origin +HEAD",
  ]) {
    assertBlocked(run(command, { cwd: onMain }), /\[gate: push\]/, /main|force/i);
  }
  // `heads/main` names main outright, so it is refused from ANY branch.
  const onFeature = sandbox({ branch: "feature/x" });
  for (const command of [
    "git push origin heads/main",
    "git push origin HEAD:heads/master",
    "git push origin feature/x:heads/main",
  ]) {
    assertBlocked(run(command, { cwd: onFeature }), /\[gate: push\]/, /main|master/);
  }
});

test("6. I1: HEAD on a feature branch is still a feature branch", () => {
  // Resolving HEAD must resolve it, not assume the worst.
  const dir = sandbox({ branch: "feature/x" });
  assertAllowed(run("git push origin HEAD", { cwd: dir }));
  assertAllowed(run("git push origin @", { cwd: dir }));
  assertAllowed(run("git push origin HEAD:feature/x", { cwd: dir }));
});

test("6. I1: --all and --mirror push main from any branch", () => {
  // These name no refspec at all, so the old code asked what a BARE push would
  // target — the current branch — and allowed it from anywhere that was not main.
  // They push every branch there is, main included, and --mirror deletes remote
  // refs that are missing locally.
  const dir = sandbox({ branch: "feature/x" });
  for (const command of [
    "git push --all origin",
    "git push --mirror origin",
    "git push --branches origin",
    "git push origin --all",
    "git push --all",
  ]) {
    assertBlocked(run(command, { cwd: dir }), /\[gate: push\]/, /every branch|--all|--mirror|--branches/i);
  }
});

test("6. I1: --tags is not --all", () => {
  // A tag does not move a branch. Sweeping it up would be the rule over-reaching,
  // and an over-reaching rule is the one that gets switched off.
  assertAllowed(run("git push --tags origin", { cwd: sandbox({ branch: "feature/x" }) }));
  assertAllowed(run("git push --follow-tags origin feature/x", { cwd: sandbox({ branch: "feature/x" }) }));
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

/** One body file per stub, so an earlier stub's env keeps reading its own body. */
let stubSeq = 0;

/**
 * A stub `gh` that prints `json` for any arguments.
 *
 * Shipped as BOTH `gh.cmd` and a `gh` shell script because the hook must reach
 * it the way it reaches the real thing. Node 22 refuses to spawn a .cmd without
 * a shell (the 2024 argument-injection fix), and a real gh on Windows can itself
 * be a .cmd shim — which is why the hook spawns gh through a shell there, and
 * why this stub is resolvable that way.
 *
 * ── WHY THE JSON GOES IN A FILE, AND WHY THIS HELPER TESTS ITSELF ────────────
 *
 * This used to be `echo '${json}'`. On Windows that works; on Linux `/bin/sh` is
 * dash, whose builtin echo INTERPRETS backslash escapes, so every `\n` in a
 * multi-line body fixture became a real newline inside a JSON string literal
 * and the hook's JSON.parse died with "Bad control character in string literal".
 *
 * The visible cost was one test, and the hidden cost was the whole point of
 * having CI: `7. a merge is allowed when the PR body carries the approved
 * verdict ON ITS OWN LINE` has never passed on Linux, the `static` job was red
 * from the commit that introduced it, and every local run on Windows was green
 * — so the suite reported a passing merge gate on the one platform CI does not
 * run. A test that cannot fail on the developer's machine is the same defect
 * class as a hook that never loads.
 *
 * So the body is written to a FILE and both halves of the stub exec THIS node
 * on a shim that reads it — no shell ever touches the JSON, and no path is
 * interpolated into a shell word. The stub is then RUN and its output parsed, so
 * a future break fails here, in the helper, naming the cause, instead of
 * surfacing as a puzzling refusal from the gate under test. That self-check has
 * already earned itself twice: it caught  on the Linux runner
 * (PATH is the stub directory alone, so no external binary is reachable) in the
 * same place it would have caught the original echo mangling.
 */
function stubGh(dir, json) {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (json === null) return envWithPath(binDir);

  const n = stubSeq++;
  const bodyFile = join(binDir, `gh-body-${n}.json`);
  const shim = join(binDir, `gh-shim-${n}.mjs`);
  writeFileSync(bodyFile, json);

  // The shim reads the body RELATIVE TO ITSELF, so no path is ever interpolated
  // into a shell word and no shell ever touches the JSON.
  writeFileSync(
    shim,
    'import { readFileSync } from "node:fs";\n' +
      `process.stdout.write(readFileSync(new URL("./gh-body-${n}.json", import.meta.url), "utf8"));\n`,
  );

  // Both halves exec THIS node by absolute path. `envWithPath` deliberately
  // replaces PATH with the stub directory alone, so that a real gh on the
  // machine can never answer — which also means the stub cannot rely on
  // anything being on PATH. That is what broke the first attempt at this:
  // `cat "<body>"` is an external binary, and on the Linux runner it failed
  // with `cat: not found` where cmd's builtin `type` had worked. process.execPath
  // needs no PATH and is the same interpreter already running the suite.
  writeFileSync(join(binDir, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${shim}"\r\n`);
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh\nexec "${process.execPath.split("\\").join("/")}" "${shim.split("\\").join("/")}"\n`,
    { mode: 0o755 },
  );

  // Self-check 1, and the one that is platform-INDEPENDENT: the POSIX stub must
  // not name a command that has to be looked up on PATH. `cat "<body>"` passed
  // every local run on Windows — where the .cmd half runs and `type` is a cmd
  // builtin — and failed on the Linux runner with `cat: not found`, because
  // envWithPath replaces PATH with the stub directory alone. Only `exec`, a
  // shell builtin, plus absolute paths. Asserted on the TEXT so that the next
  // person to reach for a convenient external command is stopped on the machine
  // they are typing on rather than ten minutes later in CI.
  // Tokenised on QUOTES, not on whitespace: process.execPath here is
  // `C:\Program Files\nodejs\node.exe`, and the first version of this check split
  // on /\s+/ and indicted "Files/nodejs/node.exe" as a PATH lookup. It failed on
  // a correct stub, which also silently voided the mutation check that was
  // supposed to prove it — the tests were red with and without the mutation.
  const posix = readFileSync(join(binDir, "gh"), "utf8");
  const script = posix.slice(posix.indexOf("\n") + 1); // drop the shebang
  for (const word of script.match(/"[^"]*"|\S+/g) ?? []) {
    const bare = word.replace(/^"|"$/g, "");
    if (bare === "exec") continue;
    assert.match(
      bare,
      /^(?:\/|[A-Za-z]:\/)/,
      `the POSIX gh stub must reach everything by ABSOLUTE path — "${bare}" would be resolved ` +
        `through PATH, and PATH here is the stub directory alone, so it will not be found on a ` +
        `machine whose shell does not happen to have it built in`,
    );
  }

  // Self-check 2: run the stub the way the hook will and require the bytes back.
  const probe = spawnSync("gh", ["pr", "view", "--json", "body"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    shell: process.platform === "win32",
    env: envWithPath(binDir),
  });
  assert.equal(probe.status, 0, `the gh stub did not run: ${probe.stderr || probe.error?.message}`);
  assert.deepEqual(
    JSON.parse(probe.stdout),
    JSON.parse(json),
    "the gh stub must reproduce its JSON byte-for-byte on this platform; if this fails, the " +
      "shell is mangling the fixture and every merge test below is testing the mangling",
  );
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

test("7. a merge is allowed when the PR body carries the approved verdict ON ITS OWN LINE", () => {
  const dir = sandbox();
  // The verdict must be a LINE. This fixture used to read
  // "## Summary ... Review-Verdict: approved" — the verdict inline in prose —
  // which passed only because the gate's regex was unanchored. See the
  // rejection cases below for what that permitted.
  const env = stubGh(dir, '{"body":"## Summary\\nsome prose\\n\\nReview-Verdict: approved\\n"}');
  assertAllowed(run("gh pr merge 42 --squash", { cwd: dir, env }));
  // No PR number: gh resolves the PR from the current branch.
  assertAllowed(run("gh pr merge --squash", { cwd: dir, env }));

  // CRLF, because GitHub bodies routinely arrive that way and a verdict that
  // works in the browser must work here.
  const crlf = stubGh(dir, '{"body":"## Summary\\r\\nReview-Verdict: approved\\r\\n"}');
  assertAllowed(run("gh pr merge 42 --squash", { cwd: dir, env: crlf }));
});

test("7. a verdict buried in prose does NOT approve a merge", () => {
  // ── WHY THE ANCHORING MATTERS ─────────────────────────────────────────────
  //
  // The gate's regex was `/Review-Verdict:\s*approved/i`, matching anywhere in
  // the body. Three things satisfied it that must not:
  //
  //   - the PULL REQUEST TEMPLATE shipped alongside this hook, which explained
  //     the rule using those literal words, so every PR opened from the default
  //     template approved itself with no review at all
  //   - `approved-with-nits`, which the template said blocks
  //   - a sentence telling you NOT to write it yet
  //
  // Each is a real body a reviewer could plausibly produce.
  const dir = sandbox();
  for (const body of [
    "do not write Review-Verdict: approved yet — finish the checklist first",
    "Review-Verdict: approved-with-nits",
    "Review-Verdict: approvedNOT",
    "the reviewer should add a line reading Review-Verdict: approved when done",
  ]) {
    assertBlocked(
      run("gh pr merge 42 --squash", { cwd: dir, env: stubGh(dir, JSON.stringify({ body })) }),
      /Review-Verdict/,
    );
  }
});

test("7. the Markdown a reviewer actually types DOES approve a merge", () => {
  // The other half of the anchoring, and the half the first version got wrong.
  // The Review section of the template is a bulleted list, so `- Review-Verdict:
  // approved` is the natural thing to write — and it was refused, along with the
  // bold spellings and a trailing full stop. A reviewer who writes the obvious
  // form, is refused, and cannot see the hook's message retypes the line until
  // something works; that is how a gate teaches people to route around it.
  const dir = sandbox();
  for (const body of [
    "Review-Verdict: approved",
    "- Review-Verdict: approved",
    "* Review-Verdict: approved",
    "**Review-Verdict:** approved",
    "**Review-Verdict**: approved",
    "Review-Verdict: approved.",
    "## Review\n\n- Review-Verdict: approved\n\nnotes below",
    "Review-Verdict: APPROVED",
  ]) {
    assertAllowed(run("gh pr merge 42 --squash", { cwd: dir, env: stubGh(dir, JSON.stringify({ body })) }));
  }
});

test("7. widening the pattern did not reopen the prose and qualified cases", () => {
  // Pinned separately from the test above so that a future widening cannot pass
  // by breaking this: a blockquote is how one quotes SOMEONE ELSE'S text, and a
  // qualified verdict is not an approval however it is punctuated.
  const dir = sandbox();
  for (const body of [
    "> Review-Verdict: approved",
    "`Review-Verdict: approved`",
    "Review-Verdict: approved with caveats",
    "Review-Verdict: approved (conditional)",
    "Review-Verdict: not approved",
    "ReviewVerdict: approved",
  ]) {
    assertBlocked(
      run("gh pr merge 42 --squash", { cwd: dir, env: stubGh(dir, JSON.stringify({ body })) }),
      /Review-Verdict/,
    );
  }
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

// ── I2: THE MERGE RULE ASKED FOR A POSITION, NOT A SUBCOMMAND ────────────────

test("7. I2: a global flag in front does not lift the merge rule", () => {
  // VERIFIED ALLOWED. The check required argv[1]==="pr" and argv[2]==="merge", so
  // one `--repo o/r` shifted the words along by two and the rule stopped applying
  // entirely. Reading POSITIONS out of a flag-bearing command line is the same
  // mistake as substring-matching "git commit", which this file already knows not
  // to do.
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"no verdict here"}');
  for (const command of [
    "gh --repo o/r pr merge 1 --squash",
    "gh -R o/r pr merge 1 --squash",
    "gh --repo=o/r pr merge 1 --squash",
    "gh pr --repo o/r merge 1 --squash",
    "gh --hostname github.com pr merge 1 --squash",
  ]) {
    assertBlocked(run(command, { cwd: dir, env }), /Review-Verdict/);
  }
  assertBlocked(run("gh --repo o/r pr merge 1 --admin", { cwd: dir, env }), /--admin/);
});

test("7. I2: gh api is the same merge with the porcelain removed", () => {
  // A verdict in the PR body is not what makes this refusable — the route is.
  // The stub below returns an APPROVED body, so nothing here passes because the
  // review check happened to fail.
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"Review-Verdict: approved"}');
  for (const command of [
    "gh api -X PUT /repos/o/r/pulls/7/merge",
    "gh api --method PUT repos/o/r/pulls/7/merge",
    "gh api -X PUT '/repos/o/r/pulls/7/merge'",
    "gh --repo o/r api -X PUT /repos/o/r/pulls/7/merge",
  ]) {
    assertBlocked(run(command, { cwd: dir, env }), /\[gate: merge\]/, /gh api/);
  }
});

test("7. I2: other gh api calls are not the merge gate's business", () => {
  const dir = sandbox();
  const env = stubGh(dir, '{"body":"x"}');
  for (const command of [
    "gh api /repos/o/r/pulls/7",
    "gh api /repos/o/r/pulls",
    "gh api /repos/o/r/pulls/7/reviews",
    "gh api user",
  ]) {
    assertAllowed(run(command, { cwd: dir, env }));
  }
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

test("9. malformed or empty payloads are allowed, and do not crash the gate", () => {
  // Exit 1 is a CRASH, and a crashing PreToolUse hook blocks nothing while
  // filling the transcript with stack traces. Exit 2 here would be worse: it
  // would block every Bash call in the session.
  //
  // ── I4: THIS ASSERTION USED TO PASS *BECAUSE OF* A CRASH ───────────────────
  // `null` is valid JSON, so readInput() returned null and `input.tool_name`
  // threw "Cannot read properties of null (reading 'tool_name')". The catch-all
  // logged it and fell through to allow(), so exit 0 was observed and this test
  // was green — while the gate had judged nothing at all. Twelve of those
  // TypeErrors sit in this worktree's workspace/gate-errors.log from one
  // 33-minute session on 2026-09-23, and FOUR more arrived while this fix was
  // being written: sixteen Bash calls went through unexamined, silently. This
  // comment previously said "three more" in one sentence and "twelve" in the
  // next, which is two wrong numbers about a file with 16 lines in it.
  //
  // The exit code alone cannot tell a clean allow from a crashed one, so the
  // ERROR LOG is asserted too: a run that judged the payload adds no line to it.
  // Driven in a sandbox so the log under assertion is the sandbox's own.
  const dir = sandbox();
  const log = join(dir, "workspace", "gate-errors.log");
  for (const input of [
    "",
    "   ",
    "not json at all",
    "null",
    "[]",
    '"a string"',
    "123",
    "false",
    "{}",
    '{"tool_input":null}',
    '{"tool_name":null,"tool_input":{"command":"ls"}}',
    '{"tool_name":"Bash","tool_input":null}',
  ]) {
    const before = existsSync(log) ? readFileSync(log, "utf8") : "";
    const r = runRaw(input, { cwd: dir });
    assert.equal(r.status, 0, `payload ${JSON.stringify(input)} → exit ${r.status}: ${r.stderr}`);
    const after = existsSync(log) ? readFileSync(log, "utf8") : "";
    assert.equal(
      after,
      before,
      `payload ${JSON.stringify(input)} made the gate log an internal error, so it allowed ` +
        `without judging:\n${after.slice(before.length)}`,
    );
  }
});

/**
 * A sandbox whose copy of _lib.mjs has a fault injected into currentBranch(), so
 * that the hook throws from inside a rule instead of from a payload shape.
 *
 * The injection is textual and asserts that it MATCHED, so a refactor of _lib.mjs
 * fails this loudly rather than turning the tests below into no-ops. Only the
 * temp copy is written; the real _lib.mjs is never touched.
 */
function brokenLibSandbox() {
  const dir = sandbox();
  const libPath = join(dir, ".claude", "hooks", "_lib.mjs");
  const src = readFileSync(libPath, "utf8");
  const marker = "export function currentBranch() {";
  assert.ok(
    src.includes(marker),
    "_lib.mjs no longer defines currentBranch() the way this test injects a fault into",
  );
  writeFileSync(libPath, src.replace(marker, `${marker}\n  throw new TypeError("injected gate fault");`));
  return dir;
}

test("9. I4: an internal error REFUSES, it does not quietly allow", () => {
  // The decision I4 forced, and it is written down in pre-bash.mjs too: a gate
  // that fails open on its own bug is off exactly when something is wrong, and
  // silent about it. That is the defect this whole layer exists to remove, so an
  // internal error is now exit 2 — loud, and fixed in minutes rather than
  // invisible for 33 of them.
  const dir = brokenLibSandbox();
  const r = run("git commit -m x", { cwd: dir });
  assertBlocked(r, /internal error/i, /injected gate fault/, /gate-errors\.log/);
  assert.match(readFileSync(join(dir, "workspace", "gate-errors.log"), "utf8"), /injected gate fault/);
});

test("9. I4: failing closed does not mean failing closed on everything", () => {
  // The fault is in currentBranch(), and `ls -la` reaches no rule that calls it.
  // A gate that refused every command because one rule is broken would be
  // indistinguishable from a gate that is switched off.
  const dir = brokenLibSandbox();
  assertAllowed(run("ls -la", { cwd: dir }));
  assertBlocked(run("rm -rf x", { cwd: dir }), /destructive/i);
});

test("9. I4: the hatch still gets past an internal error, and is recorded", () => {
  // A bug in the gate must not be able to brick a session outright. The price of
  // getting past it is the same as everywhere else: a reason, written down where
  // the PR can quote it.
  const dir = brokenLibSandbox();
  assertAllowed(run("GML_GATE_SKIP='gate is broken, see gate-errors.log' git commit -m x", { cwd: dir }));
  assert.match(
    readFileSync(join(dir, "workspace", "gate-overrides.log"), "utf8"),
    /gate-internal-error\tgate is broken/,
  );
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
    // The shapes the C4/C5 parsing added, each one stripped down to nothing.
    "env",
    "sudo",
    "nice -n",
    "timeout",
    "exec -a",
    "then",
    "done",
    "{",
    "(",
    "!",
    ")",
    "<<",
    "<<<",
    "echo $((",
    "$((1<<2))".repeat(2_000),
    "gh",
    "gh api",
    "gh --repo",
    "git --git-dir",
    "git --work-tree",
    "git push origin",
  ]) {
    const r = run(command);
    assert.ok(r.status === 0 || r.status === 2, `command ${JSON.stringify(command.slice(0, 20))} → exit ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /at Object\.|node:internal/, "a stack trace reached stderr");
    // I4: exit 2 now covers "the gate broke" as well as "refused", so a shape
    // that merely confuses the parser must not be able to masquerade as a rule.
    assert.doesNotMatch(
      r.stderr,
      /internal error/i,
      `command ${JSON.stringify(command.slice(0, 30))} crashed the gate: ${r.stderr}`,
    );
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

test("10. a pathological heredoc does not turn the gate into a stall", () => {
  // A cost the C5 fix INTRODUCED, caught before it shipped. Searching forward
  // for each delimiter was quadratic in the number of openers, and it did not
  // matter while an unterminated opener gave up at the first miss — the C5 fix
  // makes it search the whole remainder instead, so N openers cost N²/2 line
  // comparisons. Measured on `"cat <<EOF\n".repeat(N)` before the line index:
  //
  //     N = 5,000 → 0.6s     N = 10,000 → 1.5s     N = 20,000 → 4.1s
  //
  // This runs before EVERY Bash call, behind a 60s registered timeout that it
  // must never approach — and with the gate now failing CLOSED, a timeout is a
  // refused command rather than a slow one. Closing one hole is not a licence to
  // open another.
  const command = `${"cat <<EOF\n".repeat(20_000)}rm -rf node_modules`;
  const started = Date.now();
  // Still the right ANSWER, not just a fast one: every opener is unterminated,
  // so the remainder is scanned and the rm is found.
  assertBlocked(run(command), /destructive/i);
  const ms = Date.now() - started;
  assert.ok(ms < 1_500, `${ms}ms to judge 20,000 heredoc openers — the quadratic scan is back`);
});
