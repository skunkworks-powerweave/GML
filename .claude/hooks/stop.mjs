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
// hook configuration, and it is why this file's first job is simply to WRITE
// THE LINE — and why the tests read the file back rather than asserting that a
// function was called.
//
// ── WHY THIS ONE IS ALLOWED TO BLOCK ─────────────────────────────────────────
//
// Stop fires when the assistant is about to hand control back. That is the last
// moment at which "you changed apps/** and never ran the tests" is still cheap
// to say. Exit 2 with the reason on stderr is what makes Claude keep working
// instead of stopping.
//
// The danger of a blocking Stop hook is an infinite loop: block, resume, stop,
// block. Three separate brakes, because one is not enough:
//
//   1. stop_hook_active   Set by Claude Code when it is already continuing
//                         because of a Stop hook. When it is true this file
//                         exits 0, unconditionally, before any gate logic runs.
//   2. a session marker   workspace/.stop-nudged-<session_id>, written at the
//                         moment of the nudge. A session gets told once. A
//                         RESUMED session — new process, stop_hook_active gone
//                         — still sees the marker and stays quiet.
//   3. never throwing     Any unexpected error ends in exit 0. A Stop hook that
//                         crashed with a non-zero status would trap the user in
//                         a session they cannot end.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROJECT_DIR,
  allowIfOverridden,
  appendWorkspace,
  currentBranch,
  deny,
  git,
  readInput,
  receipts,
  treeHash,
} from "./_lib.mjs";

/** Directories whose contents are the product. Docs and specs are not. */
const SOURCE_DIRS = ["apps/", "packages/", "scripts/"];

try {
  const input = readInput();
  const active = Boolean(input.stop_hook_active);
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

  seedLedgerHeader();
  appendWorkspace(
    "session_log.md",
    `- ${new Date().toISOString()} · ${branch} · ${head} · ${dirty.length} dirty · ${verdict} · ${overrideText}` +
      (active ? " · (continued after a stop nudge)" : ""),
  );

  // ── The gate ───────────────────────────────────────────────────────────────

  // Brake 1. Nothing below this line may run when Claude Code is already
  // continuing on account of a Stop hook.
  if (!active && source.length > 0 && !green) {
    const marker = `.stop-nudged-${String(input.session_id ?? "nosession").replace(/[^A-Za-z0-9._-]/g, "_")}`;
    // Brake 2. Already nudged this session — say nothing and let it stop.
    if (!existsSync(resolve(PROJECT_DIR, "workspace", marker))) {
      // The escape hatch applies here as it does to the commit gate: a gate
      // with no way past it gets switched off wholesale the first time it is
      // wrong. Using it is logged, not free.
      allowIfOverridden("", "stop-gate");
      appendWorkspace(marker, new Date().toISOString());
      deny(
        [
          `[stop-gate] ${source.length} uncommitted source file(s) with no green test receipt for this exact tree:`,
          ...source.slice(0, 5).map((p) => `    ${p}`),
          source.length > 5 ? `    … and ${source.length - 5} more` : "",
          "",
          `Rule: changes under ${SOURCE_DIRS.join(", ")} are verified before a session ends.`,
          `Receipt status: ${verdict}.`,
          "",
          "Way forward — any ONE of these:",
          "  • run `pnpm test` (it writes a receipt bound to this tree), then stop",
          "  • commit the work if it is already verified",
          "  • stop again — this fires ONCE per session and will not ask twice",
          `  • ${"GML_GATE_SKIP"}=\"<reason>\" in the environment, which is logged to`,
          "    workspace/gate-overrides.log and shows up in this session's ledger line",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }
} catch {
  // Brake 3. Whatever went wrong, the user gets to end their session.
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
    "# Session log\n\nOne line per Stop: when, branch, HEAD, dirty files, test receipt, gate overrides.\n",
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
