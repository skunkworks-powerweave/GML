#!/usr/bin/env node
// PreToolUse gate for Bash. The one hook that can actually stop something.
//
// ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
//
// `scripts/block_destructive.mjs`, wired as
// `node scripts/block_destructive.mjs "$TOOL_INPUT"`. $TOOL_INPUT appears ZERO
// times in the installed Claude Code binary, so argv[2] was always the empty
// string and the only blocking hook in this project matched nothing for its
// entire life. See _lib.mjs for the verified contract; the short version is that
// the payload arrives as JSON on STDIN and a refusal is exit 2 with the reason
// on stderr.
//
// ── WHY THE PARSING IS SHAPED THE WAY IT IS ──────────────────────────────────
//
// A command string is not a command. It can be several, separated by &&, ||, ;,
// | or a newline, each one optionally prefixed with VAR=value, and it can carry
// a heredoc body that is DATA rather than anything that will execute. So the
// command is split into segments and each segment is matched on its TOKENS, not
// by searching the raw string: `git   commit` and `git -C . commit` are the same
// commit, and a substring match for "git commit" sees neither.
//
// This is deliberately a denylist, and a denylist is bounded: `$(echo rm) -rf`,
// an aliased binary, or a script that wraps the command all evade it. It is
// worth having anyway because it catches the shapes that actually occur, and it
// is honest about the rest rather than claiming to be a sandbox.
//
// ── THE TWO PLACES THIS KNOWINGLY OVER-MATCHES ───────────────────────────────
//
// 1. Segments are split without tracking quotes, so `echo "a && rm -rf x"` reads
//    as two segments and is refused. Tracking quotes would make `bash -c "rm -rf
//    x"` invisible, which is the worse failure, so the over-match is kept.
// 2. Destructive SQL is matched over the WHOLE command text including heredoc
//    bodies, because `psql <<'SQL' … DROP TABLE …` is the only shape a DROP
//    actually arrives in here. Prose that contains the phrase is refused too.
//
// Both refusals name the way out (write the text with the Write tool instead of
// through a shell), because a gate that is wrong and offers nothing gets
// disabled wholesale rather than satisfied.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  PROJECT_DIR,
  allow,
  allowIfOverridden,
  appendWorkspace,
  currentBranch,
  deny,
  git,
  latestReceipt,
  readInput,
  stagedPaths,
  treeHash,
} from "./_lib.mjs";

// ─── command parsing ─────────────────────────────────────────────────────────

/**
 * Remove heredoc BODIES, keeping the line that introduces them.
 *
 * A heredoc body is an argument, not a command: `cat <<'EOF' > notes.md` with
 * "rm -rf" in the body runs nothing. Scanning it as a command would refuse a
 * file write, which is the kind of wrongness that gets a gate turned off.
 */
function stripHeredocs(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    kept.push(line);
    i += 1;
    const opener = line.match(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!opener) continue;
    const delimiter = opener[2];
    while (i < lines.length && lines[i].trim() !== delimiter) i += 1;
    if (i < lines.length) i += 1; // drop the closing delimiter line too
  }
  return kept.join("\n");
}

/** The command text split into individually-executed segments. */
function segments(text) {
  return stripHeredocs(text)
    .split(/\r?\n|&&|\|\||[;|&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A segment's argv, with the noise that hides a command stripped from the
 * front: `FOO=bar sudo git commit` is a commit.
 *
 * The assignment is consumed off the STRING rather than token by token, because
 * its value can be quoted and contain spaces — and the override this gate ships
 * with is used exactly that way (`GML_GATE_SKIP='CI is down' git commit`). A
 * token-wise version of this read `CI` as the program name and let the commit
 * through unexamined, which is worse than not having the override at all.
 */
function argvOf(segment) {
  let rest = segment.trim();
  for (;;) {
    const prefix = rest.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|sudo\s+)/);
    if (!prefix) break;
    rest = rest.slice(prefix[0].length);
  }
  return rest.split(/\s+/).filter(Boolean);
}

/** The bare program name, so `/usr/bin/rm` and `rm` are the same program. */
function program(argv) {
  return (argv[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}

/**
 * Single-letter flags gathered across a segment, so `-fd`, `-f -d` and
 * `--force --recurse` all answer the same question. Stops at `--`, after which
 * everything is an operand.
 */
function flagsOf(args, longNames = {}) {
  const letters = new Set();
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    if (arg.startsWith("--")) {
      const mapped = longNames[arg.split("=")[0]];
      if (mapped) letters.add(mapped);
      continue;
    }
    for (const ch of arg.slice(1)) letters.add(ch);
  }
  return letters;
}

/**
 * Recognise a git invocation and return its subcommand, seeing past the global
 * options that sit between `git` and the verb. `git -C . commit` is a commit;
 * the brief calls this out because it is the obvious way past a naive match.
 */
function gitInvocation(argv) {
  if (program(argv) !== "git") return null;
  let i = 1;
  let cDir = null;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-C" || arg === "-c") {
      if (arg === "-C") cDir = argv[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=")) {
      i += 1;
      continue;
    }
    if (arg === "--no-pager" || arg === "-P" || arg === "--paginate" || arg === "--no-replace-objects") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= argv.length) return null;
  return { sub: argv[i], args: argv.slice(i + 1), cDir };
}

/** Run git for its EXIT STATUS. git() in _lib returns "" for both outcomes. */
function gitSucceeds(args) {
  try {
    const r = spawnSync("git", args, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Refuse unless the operator has explicitly and legibly taken responsibility. */
function denyOverridable(command, rule, reason) {
  allowIfOverridden(command, rule);
  deny(reason);
}

// ─── rule 1: destructive commands ────────────────────────────────────────────

const WAY_OUT_TEXT =
  "If these words are only TEXT (a doc, a commit message, a comment), write the " +
  "file with the Write tool instead of through a shell string — this gate reads " +
  "shell arguments, not intent.";

/**
 * Destructive SQL, matched over the whole command INCLUDING heredoc bodies.
 * TRUNCATE must be followed by an identifier so that prose ("never TRUNCATE.")
 * does not trip it.
 */
const SQL_PATTERNS = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+DATABASE\b/i, "DROP DATABASE"],
  [/\bTRUNCATE\s+(TABLE\s+)?["'`\w]/i, "TRUNCATE"],
];

/** Destructive shell commands, matched on a segment's tokens. */
function destructiveSegment(argv) {
  const prog = program(argv);

  if (prog === "rm") {
    const flags = flagsOf(argv.slice(1), { "--recursive": "r", "--force": "f" });
    if (flags.has("r") && flags.has("f")) return "rm -rf";
  }

  if (prog === "docker" || prog === "docker-compose") {
    const args = prog === "docker-compose" ? argv.slice(1) : argv.slice(2);
    const group = prog === "docker-compose" ? "compose" : argv[1];
    if (group === "compose" && args.includes("down")) {
      const flags = flagsOf(args, { "--volumes": "v" });
      if (flags.has("v")) return "docker compose down -v";
    }
    if (group === "volume" && args[0] === "rm") return "docker volume rm";
  }

  const g = gitInvocation(argv);
  if (g) {
    if (g.sub === "reset" && g.args.includes("--hard")) return "git reset --hard";
    if (g.sub === "clean") {
      const flags = flagsOf(g.args, { "--force": "f" });
      if (flags.has("f") && flags.has("d")) return "git clean -fd";
    }
    if (g.sub === "stash" && (g.args[0] === "drop" || g.args[0] === "clear")) {
      return `git stash ${g.args[0]}`;
    }
  }

  return null;
}

function checkDestructive(command) {
  for (const [pattern, name] of SQL_PATTERNS) {
    if (pattern.test(command)) {
      deny(
        `[gate: destructive] Refused — this command contains ${name}.\n` +
          `Data loss is not reversible by a revert, so this rule has no override.\n` +
          `Way forward: drop/rebuild schema through a numbered migration under ` +
          `packages/db/src/migrations/, and run destructive one-offs from your own ` +
          `shell where you own the consequence.\n${WAY_OUT_TEXT}`,
      );
    }
  }

  for (const segment of segments(command)) {
    const what = destructiveSegment(argvOf(segment));
    if (what) {
      const where = segment.trim() === what ? "" : `, in: ${segment}`;
      deny(
        `[gate: destructive] Refused — \`${what}\`${where}\n` +
          `This rule has no override: it exists for the operations that no later ` +
          `commit can undo.\n` +
          `Way forward: \`rm\` a specific path without -r/-f, \`git restore <path>\` ` +
          `instead of \`reset --hard\`, \`docker compose down\` without -v to keep ` +
          `volumes. If something genuinely has to be destroyed, do it yourself at a ` +
          `terminal, where you can see what you are destroying before it goes.\n` +
          `${WAY_OUT_TEXT}`,
      );
    }
  }
}

// ─── rule 6: no push to main, no force push ──────────────────────────────────

/** `git push` options that consume the NEXT argument, so it is not a refspec. */
const PUSH_OPTS_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** The branch a push with no refspec would land on. */
function impliedPushBranch() {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  // "origin/main" -> "main". The remote name is the first segment and never
  // part of the branch, so stripping one segment is exact rather than greedy.
  if (upstream) return upstream.replace(/^[^/]+\//, "");
  return currentBranch();
}

function isForceFlag(arg) {
  if (arg === "-f") return true;
  if (arg.startsWith("--force")) return true; // --force, --force-with-lease, --force-if-includes
  return /^-[A-Za-z]+$/.test(arg) && arg.includes("f"); // bundled, e.g. -fu
}

function checkPush(command) {
  for (const segment of segments(command)) {
    const g = gitInvocation(argvOf(segment));
    if (!g || g.sub !== "push") continue;

    const refspecs = [];
    let sawRemote = false;
    let forced = false;

    for (let i = 0; i < g.args.length; i += 1) {
      const arg = g.args[i];
      if (PUSH_OPTS_WITH_VALUE.has(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) {
        if (isForceFlag(arg)) forced = true;
        continue;
      }
      if (!sawRemote) {
        sawRemote = true;
        continue;
      }
      refspecs.push(unquote(arg));
    }

    // A leading "+" in a refspec is a force push spelled without a flag.
    if (refspecs.some((r) => r.startsWith("+"))) forced = true;

    if (forced) {
      deny(
        `[gate: push] Refused — this is a FORCE push.\n` +
          `Force-pushing rewrites history that other clones, and any review already ` +
          `posted on the PR, refer to by SHA. --force-with-lease is covered too: it ` +
          `narrows the race, not the rewrite. This rule has no override.\n` +
          `Way forward: move forward with commits instead — \`git revert <sha>\` to ` +
          `undo, or a fixup commit. If the branch is genuinely private and must be ` +
          `reshaped, do that before it is pushed at all.`,
      );
    }

    const targets = refspecs.length
      ? refspecs.map((r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, ""))
      : [impliedPushBranch()];

    const protectedTarget = targets.find((t) => PROTECTED_BRANCHES.has(t));
    if (protectedTarget) {
      deny(
        `[gate: push] Refused — this pushes to \`${protectedTarget}\`` +
          `${refspecs.length ? "" : " (the branch this push resolves to)"}.\n` +
          `${protectedTarget} moves through reviewed pull requests, not direct ` +
          `pushes; a direct push is also how the merge gate gets bypassed entirely. ` +
          `This rule has no override.\n` +
          `Way forward:\n` +
          `  git push -u origin <your-branch>\n` +
          `  gh pr create --fill\n` +
          `  # then merge once the PR body carries Review-Verdict: approved`,
      );
    }
  }
}

// ─── rule 8: worktrees only under .worktrees/ ────────────────────────────────

/** `git worktree add` options that consume the NEXT argument. */
const WORKTREE_OPTS_WITH_VALUE = new Set(["-b", "-B", "--reason"]);

/**
 * Keep every worktree inside .worktrees/, and keep .worktrees/ ignored.
 *
 * The path rule is the discipline; the check-ignore call is what makes it hold.
 * A worktree checkout that git does NOT ignore is swept up wholesale by the next
 * `git add -A` — a second copy of the tree committed into the first — and the
 * path alone cannot tell you whether that is the case.
 */
function checkWorktree(command) {
  for (const segment of segments(command)) {
    const g = gitInvocation(argvOf(segment));
    if (!g || g.sub !== "worktree" || g.args[0] !== "add") continue;

    const rest = g.args.slice(1);
    let path = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (WORKTREE_OPTS_WITH_VALUE.has(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      path = unquote(arg);
      break;
    }
    if (!path) continue; // `git worktree add` with no path is git's error to report

    const normalised = path.replace(/\\/g, "/");
    if (!normalised.startsWith(".worktrees/")) {
      deny(
        `[gate: worktree] Refused — \`${path}\` is outside .worktrees/.\n` +
          `Worktrees live at .worktrees/<name> so that they are ignored by git, ` +
          `found in one place, and cleaned up as a set. A worktree beside the repo ` +
          `is invisible to everyone else and outlives whoever made it. This rule ` +
          `has no override.\n` +
          `Way forward:\n` +
          `  git worktree add .worktrees/<name> -b <name>`,
      );
    }

    if (!gitSucceeds(["check-ignore", "-q", normalised])) {
      deny(
        `[gate: worktree] Refused — \`${normalised}\` is NOT ignored by git ` +
          `(\`git check-ignore -q ${normalised}\` fails).\n` +
          `A worktree checkout that git tracks gets staged wholesale by the next ` +
          `\`git add -A\`, committing a second copy of the tree into the first.\n` +
          `Way forward: add \`.worktrees/\` to .gitignore, confirm with ` +
          `\`git check-ignore -q ${normalised}\`, then create the worktree.`,
      );
    }
  }
}

// ─── rule 7: merge only with a recorded review ───────────────────────────────

const VERDICT = /Review-Verdict:\s*approved/i;

/**
 * The PR body, straight from gh.
 *
 * `shell` on Windows is not a convenience: Node 22 refuses to spawn a .cmd
 * without one (the 2024 argument-injection fix), and gh on Windows is often
 * installed as a .cmd shim. Nothing user-controlled is interpolated — the PR
 * number is matched as digits and everything else is a literal — so there is
 * nothing for the shell to expand.
 */
function ghPrBody(prNumber) {
  const args = ["pr", "view", ...(prNumber ? [prNumber] : []), "--json", "body"];
  try {
    const r = spawnSync("gh", args, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: 20_000,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) return { ok: false, why: `gh could not be run (${r.error.code ?? r.error.message})` };
    if (r.status !== 0) {
      const detail = (r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`;
      return { ok: false, why: `gh could not read the PR (${detail})` };
    }
    const body = JSON.parse(r.stdout).body;
    return { ok: true, body: typeof body === "string" ? body : "" };
  } catch (err) {
    return { ok: false, why: `gh could not be read (${err.message})` };
  }
}

/**
 * Refuse a merge that no review vouches for.
 *
 * The verdict is read from the PR BODY rather than from gh's review state
 * because that is where this project's review actually lands — and because a
 * body is the artefact a human can be pointed at afterwards. Note what this
 * does NOT prove: that the reviewer read anything. It proves a reviewer wrote a
 * verdict down, which is the difference between a claim nobody made and a claim
 * someone is on the record for.
 */
function checkMerge(command) {
  for (const segment of segments(command)) {
    const argv = argvOf(segment);
    if (program(argv) !== "gh" || argv[1] !== "pr" || argv[2] !== "merge") continue;
    const args = argv.slice(3);

    if (args.includes("--admin")) {
      deny(
        `[gate: merge] Refused — \`gh pr merge --admin\`.\n` +
          `--admin exists to bypass the branch protections and required checks that ` +
          `are the entire mechanism here; a gate that allowed it would be decoration. ` +
          `This rule has no override.\n` +
          `Way forward: get the checks green and the review recorded, then merge ` +
          `without --admin.`,
      );
    }

    const prNumber = args.find((a) => /^\d+$/.test(a));
    const result = ghPrBody(prNumber);

    if (!result.ok) {
      // "Could not check" must not read as "fine" — a gate that fails open is
      // off exactly when the tooling is broken, which is when it is needed.
      deny(
        `[gate: merge] Refused — ${result.why}.\n` +
          `This merge needs \`Review-Verdict: approved\` in the PR body, and that ` +
          `could not be verified, so it is refused rather than assumed.\n` +
          `Way forward: \`gh auth status\` (install or authenticate gh), or pass the ` +
          `PR number explicitly: gh pr merge <n> --squash.`,
      );
    }

    if (!VERDICT.test(result.body)) {
      deny(
        `[gate: merge] Refused — PR ${prNumber ?? "(current branch)"} has no recorded ` +
          `review verdict.\n` +
          `Its body must contain the line:\n` +
          `  Review-Verdict: approved\n` +
          `An approving click is not it: the verdict is written down so that what was ` +
          `reviewed, and by whom, survives in the PR. This rule has no override.\n` +
          `Way forward: have the reviewer add that line to the PR body ` +
          `(gh pr edit ${prNumber ?? "<n>"} --body-file -), then merge.`,
      );
    }
  }
}

// ─── the commit gate (rules 2-5) ─────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/** Strip the shell quoting that survives a whitespace split. */
function unquote(token = "") {
  return token.replace(/^["']|["']$/g, "");
}

/** The first `git commit` in the command, or null. */
function findCommit(command) {
  for (const segment of segments(command)) {
    const g = gitInvocation(argvOf(segment));
    if (g && g.sub === "commit") return { ...g, segment };
  }
  return null;
}

function checkCommit(command) {
  const commit = findCommit(command);
  if (!commit) return;

  // ── rule 2a: the gate can only vouch for the tree it lives in ──────────────
  // Every piece of evidence below — branch, staged paths, receipt — is read
  // from PROJECT_DIR. `git -C <elsewhere> commit` would be checked against the
  // WRONG tree and pass on evidence that describes something else entirely,
  // which is the same category of mistake as the ledger that reported
  // "1549/1549 passing" for an app that could not serve its own login page.
  if (commit.cDir) {
    const target = resolve(PROJECT_DIR, unquote(commit.cDir));
    if (target.toLowerCase() !== PROJECT_DIR.toLowerCase()) {
      deny(
        `[gate: commit scope] Refused — \`git -C ${commit.cDir}\` commits into ` +
          `another repository (${target}).\n` +
          `This gate reads the branch, the staged paths and the test receipt from ` +
          `${PROJECT_DIR}, so it cannot vouch for a commit made anywhere else.\n` +
          `Way forward: run the commit from a session whose project directory IS ` +
          `that repository, so its own gate can check it.`,
      );
    }
  }

  // ── rule 2b: no commit on a protected branch ──────────────────────────────
  const branch = currentBranch();
  if (PROTECTED_BRANCHES.has(branch)) {
    deny(
      `[gate: protected branch] Refused — committing directly to \`${branch}\`.\n` +
        `This project's discipline is one worktree per plan, reviewed as a PR; a ` +
        `commit straight to ${branch} skips the review that the merge gate exists ` +
        `to require. This rule has no override.\n` +
        `Way forward:\n` +
        `  git worktree add .worktrees/<name> -b <name>\n` +
        `  # move your work there, commit, push, open a PR\n` +
        `Your staged changes are untouched — nothing was committed.`,
    );
  }

  const staged = stagedPaths();
  checkReceipt(command, staged);
  checkTestWithCode(command, staged);
  checkMigration(command, staged);
}

// ─── rule 3: a green receipt for THIS tree ───────────────────────────────────

const RUN_TESTS = "Way forward: run `pnpm test`, then commit without changing anything in between.";

/** Code whose correctness a database-free run cannot speak to. */
function touchesRuntimeCode(staged) {
  return staged.filter((p) => /^(apps|packages)\//.test(p));
}

/**
 * Refuse a commit that is not backed by a green test run of this exact tree.
 *
 * ── WHY A FINGERPRINT AND NOT JUST A VERDICT ──────────────────────────────
 * "The tests pass" is a claim about a moment. This project shipped a ledger
 * asserting `1549/1549 passing` and `PRODUCTION LAUNCH READY` while the
 * application returned HTTP 500 on its own login page. Binding the receipt to
 * a hash of the working tree is what turns that from an assertion into
 * something checkable: edit a file after the run and the receipt stops
 * matching, which is exactly the case the claim was wrong in.
 */
function checkReceipt(command, staged) {
  const rule = "commit-receipt";
  const receipt = latestReceipt();

  if (!receipt) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — no test receipt exists.\n` +
        `A commit here has to point at a test run, and workspace/test-receipts.jsonl ` +
        `is empty or missing.\n${RUN_TESTS}`,
    );
  }

  if (receipt.exitCode !== 0) {
    const failed = (receipt.suites ?? [])
      .filter((s) => s.ran && s.status !== 0)
      .map((s) => `${s.suite} (${s.failed ?? "?"} failing: ${(s.failing ?? []).slice(0, 3).join(", ") || "see output"})`);
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — the latest receipt says the tests failed ` +
        `(exit ${receipt.exitCode}).\n` +
        `  ${failed.join("\n  ") || "no suite detail recorded"}\n` +
        `Committing red is how 28 assertions in this repo ended up pinning defects ` +
        `in place rather than catching them.\n${RUN_TESTS}`,
    );
  }

  const now = treeHash();
  if (receipt.treeHash !== now) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — stale receipt.\n` +
        `  receipt tree: ${String(receipt.treeHash).slice(0, 12)} (run at ${receipt.ts})\n` +
        `  working tree: ${now.slice(0, 12)}\n` +
        `The tree has changed since the tests ran, so the receipt describes code ` +
        `that is not what you are about to commit.\n${RUN_TESTS}`,
    );
  }

  // A run with no DATABASE_URL never executed tests/behaviour — the only tier
  // that can observe a runtime behaviour. tests/governance regex-matches source
  // text and was green for months while the app could not boot, so it is not
  // cover for a change to the code that boots.
  const runtime = touchesRuntimeCode(staged);
  if (receipt.noDb === true && runtime.length) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — green, but WITHOUT A DATABASE, and this ` +
        `commit touches runtime code:\n` +
        `  ${runtime.slice(0, 5).join("\n  ")}\n` +
        `The receipt records that tests/behaviour did not run for lack of ` +
        `DATABASE_URL. What did run (tests/governance) matches source TEXT and ` +
        `cannot observe whether any of this works.\n` +
        `Way forward: set DATABASE_URL (or TEST_DATABASE_URL) and run \`pnpm test ` +
        `behaviour\`, then commit.`,
    );
  }
}

// ─── rule 4: test with code ──────────────────────────────────────────────────

/** A file that IS a test, wherever it lives. */
function isTestPath(p) {
  return /^tests\//.test(p) || /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/** A file whose correctness something has to demonstrate. */
function needsEvidence(p) {
  if (isTestPath(p)) return false;
  return /^apps\//.test(p) || /^packages\//.test(p) || /^scripts\/[^/]+\.sh$/.test(p) || /^docker\//.test(p);
}

/**
 * Refuse code that arrives without a test in the same commit.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────
 * Every test in this project's history shipped in the same commit as the code
 * it tests, written afterwards to describe what the code already did. At least
 * 28 assertions ended up PINNING a defect in place — they assert the broken
 * behaviour, so fixing it turns them red. Requiring a test to be staged does
 * not by itself prove the test was written first; it makes the absence of one
 * visible at the only moment anyone is looking.
 */
function checkTestWithCode(command, staged) {
  const uncovered = staged.filter(needsEvidence);
  if (!uncovered.length) return;
  if (staged.some((p) => /^tests\//.test(p))) return;

  denyOverridable(
    command,
    "test-with-code",
    `[gate: test with code] Refused — code is staged with nothing under tests/ ` +
      `beside it:\n` +
      `  ${uncovered.slice(0, 8).join("\n  ")}\n` +
      `EVIDENCE PER ARTEFACT — each artefact has one kind of evidence that counts:\n` +
      `  .ts/.tsx in apps|packages  -> a tests/behaviour test that EXECUTES it\n` +
      `  scripts/*.sh               -> a tests/scripts test that RUNS it\n` +
      `  docker/**                  -> a tests/integration check against a booted stack\n` +
      `  an edit to tests/governance -> a MUTATION check quoted in the PR: break the\n` +
      `                                thing on purpose and show the test goes red\n` +
      `A tests/governance assertion is not evidence for any of the above: it matches ` +
      `source TEXT, and it was green for months while the app could not serve its own ` +
      `login page.\n` +
      `Way forward: stage the test in this commit. If it genuinely needs none — a ` +
      `rename, a comment — say so: GML_GATE_SKIP='<why>' git commit …`,
  );
}

// ─── rule 5: a schema change needs a migration ───────────────────────────────

const SCHEMA_DIR = /^packages\/db\/src\/schema\//;
const NUMBERED_MIGRATION = /^packages\/db\/src\/migrations\/\d{4}_[^/]*\.sql$/;
const POST_MIGRATION = /^packages\/db\/src\/migrations\/_post\//;
const JOURNAL_PATH = "packages/db/src/migrations/meta/_journal.json";

/** Paths this commit ADDS, as opposed to edits. */
function addedPaths() {
  const out = git(["diff", "--cached", "--name-only", "--diff-filter=A"]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * A schema edit with no migration beside it is a database that drifts.
 *
 * ── WHY _post/ DOES NOT COUNT ─────────────────────────────────────────────
 * packages/db/src/migrations/ has two lanes. drizzle-kit GENERATES the numbered
 * ones and records each in meta/_journal.json, which is what the migrate
 * container replays to decide what has already run. `_post/` is the hand-written
 * raw-SQL lane (grants, RLS, storage policies) and appears in no journal, so a
 * change parked there runs on whatever schedule the operator remembers. A schema
 * change covered only by a _post file therefore has no recorded relationship to
 * the schema it is supposed to accompany.
 *
 * The migration must be ADDED, not edited: rewriting a migration that has
 * already run changes the file a deployed database will never replay, which
 * diverges the code from the database silently.
 */
function checkMigration(command, staged) {
  if (!staged.some((p) => SCHEMA_DIR.test(p))) return;

  const added = addedPaths();
  const newMigration = added.find((p) => NUMBERED_MIGRATION.test(p));
  const journal = staged.includes(JOURNAL_PATH);
  if (newMigration && journal) return;

  const editedMigration = staged.find((p) => NUMBERED_MIGRATION.test(p) && !added.includes(p));
  const post = staged.filter((p) => POST_MIGRATION.test(p));

  const notes = [];
  if (editedMigration) {
    notes.push(
      `  NOTE: ${editedMigration} is staged as an EDIT to an existing migration. ` +
        `A migration that has already run is history; editing it changes nothing in ` +
        `a deployed database and diverges it from the journal. Add a new one.`,
    );
  }
  if (post.length) {
    notes.push(
      `  NOTE: ${post[0]} is in the _post/ lane, which does NOT satisfy this rule. ` +
        `drizzle-kit generates the numbered migrations and records them in ` +
        `_journal.json; _post/ is the hand-written raw-SQL lane, is in no journal, ` +
        `and drifts from it.`,
    );
  }

  denyOverridable(
    command,
    "schema-migration",
    `[gate: schema] Refused — packages/db/src/schema/** is staged without the ` +
      `migration that carries it.\n` +
      `  ${newMigration ? "ok     " : "MISSING"} a NEW numbered migration ` +
      `packages/db/src/migrations/NNNN_*.sql\n` +
      `  ${journal ? "ok     " : "MISSING"} ${JOURNAL_PATH}\n` +
      (notes.length ? `${notes.join("\n")}\n` : "") +
      `Way forward: \`pnpm --filter @gml/db generate\` (drizzle-kit writes both the ` +
      `SQL and the journal entry), review the SQL, then stage both with the schema.`,
  );
}

// ─── entry point ─────────────────────────────────────────────────────────────

function main() {
  const input = readInput();
  if (input.tool_name && input.tool_name !== "Bash") allow();

  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) allow();

  checkDestructive(command);
  checkPush(command);
  checkMerge(command);
  checkWorktree(command);
  checkCommit(command);
}

try {
  main();
} catch (err) {
  // A gate that crashes blocks ALL work, which is how an enforcement layer gets
  // ripped out. Failing open is the right direction for a bug in the gate — but
  // silently failing open is how the previous hooks stayed invisible across 27
  // commits, so the failure is recorded where it can be found.
  appendWorkspace(
    "gate-errors.log",
    `${new Date().toISOString()}\tpre-bash\t${err?.stack?.split("\n")[0] ?? err}`,
  );
}
allow();
