#!/usr/bin/env node
// Stop — the session ledger, and the last chance to notice unverified work.
//
// ── WHAT THIS REPLACES, AND THE PROOF IT NEVER RAN ───────────────────────────
//
// scripts/stop_session.mjs is eleven lines long and appends to
// workspace/session_log.md with NO condition around the write — there is no
// path through it that does not append. workspace/session_log.md is 112 bytes:
// a header, nothing else, mtime unchanged since the day it was created, across
// every session that produced this project's 27 commits.
//
// A script that always writes, and a file that never grew, can only mean the
// script was never executed. That is the single most useful fact about the old
// hook configuration, and it is why this file's ONLY job is to WRITE THE LINE
// — and why the tests read the file back rather than asserting that a function
// was called.
//
// ── WHY THIS ONE DOES NOT BLOCK ──────────────────────────────────────────────
//
// It used to try. This file carried a "WHY THIS ONE IS ALLOWED TO BLOCK"
// header, a refusal on uncommitted source with no green receipt, and three
// brakes against a block/resume loop. None of it could ever run. The
// registration in .claude/settings.json is
//
//     node "$CLAUDE_PROJECT_DIR"/.claude/hooks/stop.mjs || true
//
// and `bash -c 'node -e "process.exit(2)" || true'` exits 0. Measured on that
// code, with uncommitted apps/** and no receipt: the bare script exited 2, the
// registered command exited 0. CLAUDE.md's hooks table, this header and a test
// in session.test.mjs all described a refusal that had never once reached
// Claude Code — and every test passed throughout, because one tested the
// registration, another tested the file, and nothing tested the pair.
//
// Given the real choice — drop `|| true` and let it block, or delete the gate
// — the gate goes, for four reasons:
//
//   1. It is redundant. pre-bash.mjs refuses a `git commit` that has no green
//      receipt for the exact tree being committed: the same invariant, enforced
//      at the door where it changes the outcome. Unverified work that never
//      becomes a commit has cost nothing yet.
//   2. The "once per session" brake was never durable. It armed itself by
//      writing workspace/.stop-nudged-<session_id> through appendWorkspace(),
//      which swallows write failures BY DESIGN so that a hook never fails a
//      tool call over a log. Make workspace/ unwritable and the marker never
//      arms: measured, five consecutive stops under one session_id each exited
//      2. A brake whose arming is best-effort is not a brake.
//   3. Stop is the only hook here whose failure mode is a session the user
//      cannot end. That is the worst outcome this layer can produce, and it was
//      being risked for a nudge.
//   4. A blocking Stop would need a third registration shape — neither
//      `|| exit 2` (which would refuse on any crash, wedging the session) nor
//      `|| true` — breaking the one clean rule fail-closed.test.mjs pins:
//      blocking hooks fail closed, advisory hooks cannot wedge a session.
//
// The signal is kept; only the refusal is dropped. The ledger line carries the
// source-file count and the receipt verdict, and session-start.mjs reads the
// same facts back at the top of the next session. What was a block is now a
// record — which is what this hook was always actually for, and what it never
// once delivered.
//
// tests/hooks/fail-closed.test.mjs now runs this file THROUGH its registered
// command shape and asserts the observed exit code matches what the file
// claims. That test is the one whose absence let the contradiction exist.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROJECT_DIR,
  appendWorkspace,
  currentBranch,
  git,
  readInput,
  receipts,
  treeHash,
} from "./_lib.mjs";

/**
 * Directories whose contents are the product. Docs and specs are not.
 *
 * Still load-bearing with the gate gone: the ledger line counts these
 * separately, because "4 dirty" and "4 dirty (4 source)" are different facts
 * about how a session ended and only the second one is worth reading back.
 */
const SOURCE_DIRS = ["apps/", "packages/", "scripts/"];

try {
  const input = readInput();
  const isRepo = git(["rev-parse", "--is-inside-work-tree"]) === "true";

  // ── Facts, each read live ──────────────────────────────────────────────────

  const branch = isRepo ? currentBranch() || "(detached)" : "(not a git repo)";
  const head = isRepo ? git(["rev-parse", "--short", "HEAD"]) || "none" : "none";
  const dirty = isRepo ? dirtyPaths() : [];
  const source = dirty.filter((p) => SOURCE_DIRS.some((d) => p.startsWith(d)));

  // A receipt is only cover for the tree it was produced from; `noDb` means
  // test-gate could not run the database-backed suites, which it explicitly
  // refuses to let stand in for apps/** or packages/** changes.
  const hash = isRepo ? treeHash() : "";
  const green = hash
    ? receipts().find((r) => r.treeHash === hash && r.exitCode === 0 && !r.noDb)
    : null;
  const verdict = describeReceipt(green, hash);

  // ── Overrides taken during THIS session ────────────────────────────────────
  //
  // There is no session start time in the Stop payload, so the boundary is the
  // previous ledger entry: everything logged since the last time a session
  // ended. That is self-correcting — each entry moves the boundary forward, so
  // an override is attributed to exactly one session and never repeats.
  const overrides = overridesSince(lastLedgerTimestamp());

  // ── The line ───────────────────────────────────────────────────────────────

  const overrideText = overrides.length
    ? `overrides: ${overrides.length} (${overrides.map((o) => `${o.rule}: ${o.reason}`).join("; ")})`
    : "overrides: 0";

  // The source count is on the line because it is exactly what the removed
  // gate would have refused over. Relocating that fact into the record is the
  // whole of what replaced the refusal — a line that said only "4 dirty" would
  // have dropped the signal rather than moved it.
  const dirtyText = source.length
    ? `${dirty.length} dirty (${source.length} source)`
    : `${dirty.length} dirty`;

  // The session id is sanitised before it reaches a markdown line the ledger
  // is read from. It is payload, not input we control: a value containing a
  // newline and "- " would forge entries in an append-only file, which is the
  // one property that makes the ledger worth reading.
  const session = String(input.session_id ?? "unknown")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 64);

  seedLedgerHeader();
  appendWorkspace(
    "session_log.md",
    `- ${new Date().toISOString()} · ${session} · ${branch} · ${head} · ${dirtyText} · ${verdict} · ${overrideText}`,
  );
} catch {
  // Whatever went wrong, the user gets to end their session. This is the only
  // brake left and the only one that was ever sound: a Stop hook exiting
  // non-zero on a crash is the failure mode that traps someone in a session.
}

process.exit(0);

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Every path git considers dirty, one row per FILE.
 *
 * -uall matters: without it an untracked DIRECTORY is a single row, so a
 * session that created apps/web/src/app/admin/ with twenty new files would be
 * summarised as one dirty path and could slip under a gate that counts them.
 */
function dirtyPaths() {
  const porcelain = git(["status", "--porcelain", "-uall"]);
  if (!porcelain) return [];
  return porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => {
      let p = row.slice(3);
      // Renames arrive as "old -> new"; the new path is the one that exists.
      const arrow = p.indexOf(" -> ");
      if (arrow !== -1) p = p.slice(arrow + 4);
      return p.replace(/^"(.*)"$/, "$1");
    });
}

function describeReceipt(green, hash) {
  if (green) {
    const suites = (green.suites ?? [])
      .filter((s) => s.ran)
      .map((s) => `${s.suite} ${s.passed ?? 0} ok`)
      .join(", ");
    return `GREEN${suites ? ` (${suites})` : ""}`;
  }
  const all = receipts();
  if (all.length === 0) return "no receipt";
  const latest = all[all.length - 1];
  if (hash && latest.treeHash !== hash) return "receipt stale (different tree)";
  if (latest.exitCode !== 0) return "RED";
  if (latest.noDb) return "receipt incomplete (no DATABASE_URL)";
  return "no receipt for this tree";
}

/** The timestamp of the previous ledger entry, or null when there is none. */
function lastLedgerTimestamp() {
  try {
    const rows = read(resolve(PROJECT_DIR, "workspace", "session_log.md"))
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "));
    if (rows.length === 0) return null;
    const m = rows[rows.length - 1].match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    return m ? Date.parse(m[0]) : null;
  } catch {
    return null;
  }
}

function overridesSince(since) {
  try {
    return read(resolve(PROJECT_DIR, "workspace", "gate-overrides.log"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [ts, rule, ...rest] = l.split("\t");
        return { at: Date.parse(ts), rule: rule ?? "?", reason: rest.join(" ").trim() };
      })
      .filter((o) => Number.isFinite(o.at) && (since === null || o.at > since));
  } catch {
    return [];
  }
}

/** A ledger a human opens should say what it is. Written once, on creation. */
function seedLedgerHeader() {
  const p = resolve(PROJECT_DIR, "workspace", "session_log.md");
  if (existsSync(p)) return;
  appendWorkspace(
    "session_log.md",
    "# Session log\n\nOne line per Stop: when, session, branch, HEAD, dirty files (how many are\n" +
      "source), test receipt, gate overrides. This hook records; it does not block.\n",
  );
}

/** Read a workspace file, or "" when it is absent. */
function read(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
