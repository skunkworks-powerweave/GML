#!/usr/bin/env node
// PostToolUse (Bash) — BASH-SIDE EDITS CANNOT DODGE THE TEST-FIRST RULE.
//
// The edit hooks only see Edit/Write/MultiEdit. A heredoc, a `sed -i`, a `cp`,
// a code generator or a `git checkout -- .` writes source files without any of
// them firing, which is a hole wide enough to drive the whole project through —
// and this project has never once written a failing test first, so the hole is
// not theoretical.
//
// ── THE SNAPSHOT CONTRACT ───────────────────────────────────────────────────
//
// The contract is: pre-bash.mjs writes `git status --porcelain` to
// workspace/.status-snapshot BEFORE each Bash call, and this hook reads that
// file afterwards and diffs it against the current status. The difference is
// what the Bash call did. That path is shared state between exactly two files
// and must be spelled `workspace/.status-snapshot` in both.
//
// AS OF THIS WRITING PRE-BASH DOES NOT WRITE IT. `grep -n snapshot
// .claude/hooks/pre-bash.mjs` finds nothing, so this hook is inert until the
// producing side lands — reported as a cross-boundary need rather than fixed
// here, because pre-bash.mjs is not this file's to edit.
//
// A missing snapshot therefore means silence, not a complaint. Half a contract
// is a normal state during a rollout, and a hook that shouted about its
// sibling's absence would be noise on every single Bash call — which is exactly
// how the previous generation of hooks earned being ignored.
//
// ── WHAT THIS CANNOT DO ─────────────────────────────────────────────────────
//
// PostToolUse runs after the command has already executed, so it cannot undo
// anything; feedback() puts the omission in front of Claude while the work is
// still in hand. The commit gate in pre-bash.mjs is the backstop for anything
// that matters — this is a nudge at the moment of the edit, not a gate.
//
// Known blind spot, stated rather than hidden: a file that was ALREADY ` M`
// before the Bash call is still ` M` afterwards, so a further edit to it is
// invisible here. The commit gate catches that case, because it compares the
// receipt's tree hash against the tree actually being committed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_DIR, allow, feedback, git, readInput } from "./_lib.mjs";

/** Shared with pre-bash.mjs, which WRITES this file before every Bash call. */
const SNAPSHOT_PATH = resolve(PROJECT_DIR, "workspace", ".status-snapshot");

/**
 * `git status --porcelain` parsed into path -> status code.
 *
 * Renames arrive as `R  old -> new`; only the destination is a change worth
 * reporting. Paths containing spaces or non-ASCII arrive quoted, so the quotes
 * come off — otherwise `"apps/web/src/a b.ts"` would never match the source
 * prefixes below and would be silently exempt from the rule.
 */
function parseStatus(text) {
  const map = new Map();
  for (const line of (text || "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/g, "");
    if (path) map.set(path, code);
  }
  return map;
}

const isSource = (p) =>
  /^apps\/[^/]+\/src\//.test(p) || /^packages\/[^/]+\/src\//.test(p);

// Every tier this project uses: tests/governance, tests/behaviour,
// tests/integration, tests/scripts, tests/hooks, plus co-located specs.
const isTest = (p) =>
  p.startsWith("tests/") ||
  p.includes("/__tests__/") ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

function main() {
  const input = readInput();
  if (input.tool_name && input.tool_name !== "Bash") allow();

  if (!existsSync(SNAPSHOT_PATH)) allow();

  let before;
  try {
    before = parseStatus(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    allow();
  }

  // `-uall` matters, and this is the one place the two sides deliberately
  // differ. Plain `git status --porcelain` COLLAPSES an untracked directory to
  // a single `?? apps/` entry, so a Bash call that generates a whole new source
  // tree would produce one line that matches none of the source prefixes below
  // and the hook would be silent exactly when it had the most to say. Asking
  // for every file here, and expanding collapsed directories out of the
  // snapshot in `wasKnown`, makes this correct whichever spelling pre-bash used.
  //
  // git() returns "" rather than throwing when this is not a repository, which
  // is indistinguishable from a clean tree. Both mean "nothing to say".
  const after = parseStatus(git(["status", "--porcelain", "-uall"]));

  /** True when the snapshot already accounted for this path. */
  const wasKnown = (path, code) => {
    if (before.get(path) === code) return true;
    for (const [seen, seenCode] of before) {
      if (seen.endsWith("/") && seenCode === code && path.startsWith(seen)) return true;
    }
    return false;
  };

  const appeared = [];
  for (const [path, code] of after) {
    if (!wasKnown(path, code)) appeared.push(path);
  }

  const sources = appeared.filter((p) => isSource(p) && !isTest(p));
  if (!sources.length) allow();
  if (appeared.some(isTest)) allow();

  const list = sources.slice(0, 12);
  const more = sources.length - list.length;
  feedback(
    `[test-first] That Bash call changed source with no test alongside it:\n` +
      list.map((p) => `  - ${p}`).join("\n") +
      (more > 0 ? `\n  ... and ${more} more` : "") +
      `\n\nThe rule is test-first, and writing through Bash does not exempt a ` +
      `change from it — the Edit/Write hooks simply cannot see a heredoc or a ` +
      `\`sed -i\`. Way forward: write the failing test now, watch it fail, then ` +
      `keep the code that makes it pass. If this change genuinely has no ` +
      `observable behaviour (a rename, a comment, generated output), say so in ` +
      `the commit message so the next reader does not have to guess.`,
  );
}

// A hook must never crash: a thrown error here would print a stack trace after
// every Bash call in the repo, and the fix everyone reaches for is deleting the
// hook. Any internal failure ends in allow().
try {
  main();
} catch {
  allow();
}
