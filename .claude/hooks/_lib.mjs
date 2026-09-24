// Shared helpers for every hook in this directory.
//
// ── THE CONTRACT, VERIFIED AGAINST THE INSTALLED BINARY ──────────────────────
//
// The hooks this replaces were written against a contract that does not exist,
// and so enforced nothing for the life of the project. Every fact below was
// checked by grepping the installed Claude Code CLI rather than taken from
// documentation or memory:
//
//   input            JSON on STDIN. There is no $TOOL_INPUT environment
//                    variable — it appears ZERO times in the binary. The old
//                    hook ran `node scripts/block_destructive.mjs "$TOOL_INPUT"`
//                    and read process.argv[2], which was always empty, so the
//                    one blocking hook in the project never matched anything.
//
//   pathGlob         NOT a config field — zero occurrences. The three
//                    "path-scoped" hooks in the old settings.json fired on
//                    every Edit/Write regardless. A hook that wants to act on
//                    certain paths must inspect tool_input.file_path itself.
//
//   blocking         PreToolUse: exit 2, with the reason on STDERR.
//
//   Stop             A real event (13 occurrences), despite one source of
//                    documentation claiming otherwise. `stop_hook_active` is
//                    also real, and is how a Stop hook avoids looping.
//
// Fields on the stdin object: session_id, transcript_path, cwd,
// hook_event_name, and for tool events tool_name, tool_input, tool_use_id.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This file's directory: <repo>/.claude/hooks */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository this hook is acting on.
 *
 * $CLAUDE_PROJECT_DIR is the directory the SESSION started in, which is not
 * necessarily the repository: a session started in D:\GML sets it there, while
 * the repo is D:\GML\lms-app — and that mismatch is why the previous hooks
 * never ran at all. Preferring the hook's OWN location makes that irrelevant:
 * these files live inside the repo by definition, and in a git worktree they
 * live inside that worktree, which is the tree the commit will come from.
 *
 * $CLAUDE_PROJECT_DIR is used only as a sanity check, never as the answer.
 */
export const PROJECT_DIR = resolve(HERE, "..", "..");

/** True when the session was started somewhere other than this repository. */
export function sessionRootMismatch() {
  const started = process.env.CLAUDE_PROJECT_DIR;
  if (!started) return null;
  const a = resolve(started).toLowerCase();
  const b = PROJECT_DIR.toLowerCase();
  return a === b ? null : { started: resolve(started), repo: PROJECT_DIR };
}

/** Read and parse the hook payload from stdin. Never throws. */
export function readInput() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** Run git in the project directory. Returns trimmed stdout, or "" on failure. */
export function git(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      cwd: opts.cwd ?? PROJECT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: opts.timeout ?? 15_000,
    }).trim();
  } catch {
    return "";
  }
}

/** The branch currently checked out, or "" when detached/unavailable. */
export function currentBranch() {
  return git(["branch", "--show-current"]);
}

/** Paths staged for commit. */
export function stagedPaths() {
  const out = git(["diff", "--cached", "--name-only"]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * A fingerprint of the working tree, used to bind a test receipt to the exact
 * state it was produced from.
 *
 * Hashed in this order, NUL-separated:
 *
 *   1. `git rev-parse HEAD`          the commit being built on
 *   2. the literal "worktree"
 *   3. `git diff HEAD --binary`      unstaged changes against HEAD
 *   4. the literal "index"
 *   5. `git diff --cached --binary`  STAGED changes
 *   6. each untracked path (workspace/ excluded), sorted, then its base64 bytes
 *
 * ── C3(a): HEAD, because without it every clean tree shared one hash ─────────
 *
 * This used to hash `git diff HEAD` and untracked files and nothing else. On a
 * clean tree with nothing untracked that is the empty string, so the fingerprint
 * was sha256("") — e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 * — the same value for every clean tree, on every branch, at every commit, in
 * every repository. Verified on this worktree, which was in exactly that state.
 * A green receipt earned anywhere satisfied the commit gate everywhere.
 *
 * ── C3(b): the index, because that is what `git commit` actually writes ──────
 *
 * `git diff HEAD` reports the WORKTREE against HEAD and says nothing about the
 * index. Stage a payload, then put the worktree file back to HEAD's bytes — or
 * run `git stash push --keep-index`, which reaches that state in one command —
 * and `git diff HEAD` is empty while the index still carries the change.
 * Verified: a tree with "MALICIOUS" staged fingerprinted to the clean-tree
 * constant above, and the commit that would have followed writes the index.
 *
 * The two diffs sit under their own literal labels, so a change cannot move
 * between the worktree and the index without the fingerprint noticing.
 *
 * `workspace/` stays excluded: it holds the receipts themselves, so including it
 * would make every receipt stale the instant it was written. Untracked files are
 * covered because a new source file with no test is untracked right up until the
 * commit, and that is exactly what this is meant to catch.
 */
export function treeHash() {
  const head = git(["rev-parse", "HEAD"]);
  const worktreeDiff = git(["diff", "HEAD", "--binary"]);
  const indexDiff = git(["diff", "--cached", "--binary"]);
  const untracked = git(["ls-files", "-o", "--exclude-standard"])
    .split(/\r?\n/)
    .filter((p) => p && !p.startsWith("workspace/"))
    .sort();
  const parts = [head, "worktree", worktreeDiff, "index", indexDiff];
  for (const p of untracked) {
    parts.push(p);
    try {
      parts.push(readFileSync(resolve(PROJECT_DIR, p)).toString("base64"));
    } catch {
      parts.push("<unreadable>");
    }
  }
  // NUL as the separator, because it is the one byte that cannot appear in a
  // path or in base64 content — so no file's bytes can forge a part boundary.
  // (A `sed` pass briefly turned this into the literal string "0000", which
  // would have been separable by file content. Written via a real edit now.)
  return createHash("sha256").update(parts.join(String.fromCharCode(0))).digest("hex");
}

/** Path to the receipts file written by scripts/test-gate.mjs. */
export const RECEIPTS_PATH = resolve(PROJECT_DIR, "workspace", "test-receipts.jsonl");

/** Every receipt, oldest first. Missing file is not an error. */
export function receipts() {
  try {
    return readFileSync(RECEIPTS_PATH, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The most recent receipt, or null. */
export function latestReceipt() {
  const all = receipts();
  return all.length ? all[all.length - 1] : null;
}

/** Append a line to a file under workspace/, creating the directory. */
export function appendWorkspace(name, line) {
  const p = resolve(PROJECT_DIR, "workspace", name);
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    // A hook must never fail the tool call because it could not write a log.
  }
}

/**
 * Refuse the tool call.
 *
 * Exit 2 is what blocks a PreToolUse; the reason goes to stderr, where Claude
 * reads it. Every refusal here names the rule AND the way forward, because a
 * gate that only says "no" gets worked around rather than satisfied.
 */
export function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Allow the tool call. */
export function allow() {
  process.exit(0);
}

/**
 * Feed a message back to Claude without blocking.
 *
 * PostToolUse cannot undo the tool call, so this is advisory by construction;
 * the commit gate in pre-bash.mjs is the backstop for anything that matters.
 */
export function feedback(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reason },
    }),
  );
  process.exit(0);
}

/** The escape hatch, and the record of its use. */
export const OVERRIDE_ENV = "GML_GATE_SKIP";

export function overrideReason(command = "") {
  const inline = command.match(/GML_GATE_SKIP=(["']?)([^"'\s][^"']*)\1/);
  return inline ? inline[2] : (process.env[OVERRIDE_ENV] || "");
}

/**
 * Honour an explicit override, recording it.
 *
 * The hatch exists because a gate with no way past it gets disabled wholesale
 * the first time it is wrong. Every use is logged and is meant to be quoted in
 * the pull request, so the cost of using it is visibility rather than friction.
 */
export function allowIfOverridden(command, rule) {
  const reason = overrideReason(command);
  if (!reason) return false;
  appendWorkspace(
    "gate-overrides.log",
    `${new Date().toISOString()}\t${rule}\t${reason}`,
  );
  process.stderr.write(`[gate] ${rule} overridden: ${reason}\n`);
  process.exit(0);
}
