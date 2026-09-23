#!/usr/bin/env node
// SessionStart — the first thing a session reads, so every line must be TRUE.
//
// ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
//
// scripts/session_start.mjs printed one line:
//
//     GML LMS — spec 079 active · 45/79 complete
//
// `079` and `45` came from workspace/state.json, a file last written
// 2026-06-01; `79` was a hardcoded fallback. On disk there are 153 spec folders
// and the ledger claims 171 entries. So the sentence was wrong in all three
// numbers, and because STDOUT from this hook is injected into Claude's context,
// every session in this project began by being told something false — and then
// planned against it.
//
// The rule here is therefore narrow and absolute: print only what is read LIVE,
// at this moment, from the thing itself. No cached counts, no state file, no
// progress percentage derived from a document that nobody updates. Where a fact
// cannot be read right now, this says so rather than guessing.
//
// ── CONSTRAINTS ──────────────────────────────────────────────────────────────
//
// Never fail    A crash here would put a stack trace at the head of every
//               session's context. Everything is wrapped; the process exits 0
//               on any path, including "this is not a git repository".
//
// Stay short    ~15 lines. This text is prepended to a real conversation; a
//               dashboard would push the user's actual question out of view.
//
// No secrets    Only paths, branch names, counts and PR titles are printed.
//               Nothing reads .env, and no command output is echoed raw.
//
// Speed         SessionStart runs ONCE per session, not per tool call, so the
//               5s ceiling on `gh` is affordable here in a way it would not be
//               in pre-bash.mjs. `gh` is skipped entirely unless origin is
//               actually a GitHub remote, which keeps worktrees and detached
//               clones from paying for a call that cannot answer.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROJECT_DIR,
  currentBranch,
  git,
  latestReceipt,
  sessionRootMismatch,
  treeHash,
} from "./_lib.mjs";

const out = [];
const say = (line) => out.push(line);

/** Run one fact-gathering step; a step that throws contributes nothing. */
function step(fn) {
  try {
    fn();
  } catch {
    // Deliberately silent. A missing fact is a smaller problem than a hook that
    // dies and takes the whole session's context with it.
  }
}

// ── Where we are, and whether the gates are even loaded ──────────────────────

step(() => {
  say(`repo: ${PROJECT_DIR}`);

  const mismatch = sessionRootMismatch();
  if (!mismatch) return;
  // This is the failure that hid every other failure in this project: hooks are
  // loaded from the directory the SESSION started in. A session started in
  // D:\GML with the repo at D:\GML\lms-app loads no hooks from the repo at all,
  // which is why the old gates appeared to be installed and never fired once.
  say(`!! SESSION ROOT MISMATCH — this session started in ${mismatch.started}`);
  say(`!! Hooks load from the session's directory, NOT from the repo, so the`);
  say(`!! gates in ${mismatch.repo}/.claude are not installed: there is`);
  say(`!! no enforcement in this session. Restart Claude Code from the repo.`);
});

// ── Branch ───────────────────────────────────────────────────────────────────

const isRepo = git(["rev-parse", "--is-inside-work-tree"]) === "true";

step(() => {
  if (!isRepo) {
    say("branch: (not a git repository — no branch, commit or test gates apply)");
    return;
  }
  const branch = currentBranch();
  say(`branch: ${branch || "(detached HEAD)"}`);
  if (branch === "main" || branch === "master") {
    say(`!! on ${branch} — work belongs on a branch: git switch -c <name>`);
  }
});

// ── Working tree ─────────────────────────────────────────────────────────────

step(() => {
  if (!isRepo) return;
  // -uall, because plain `git status --porcelain` collapses an untracked
  // DIRECTORY into one row: fifty new files under apps/web/ would be reported
  // as "1 untracked". The first cut of this hook did exactly that.
  const porcelain = git(["status", "--porcelain", "-uall"]);
  const rows = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
  const untracked = rows.filter((l) => l.startsWith("??")).length;
  say(`tree: ${rows.length - untracked} modified, ${untracked} untracked`);
});

// ── The latest test receipt, checked against the tree it claims ──────────────

step(() => {
  const receipt = latestReceipt();
  if (!receipt) {
    say("tests: no test receipt — run `pnpm test` before committing");
    return;
  }

  const ageMs = Date.now() - Date.parse(receipt.ts ?? "");
  const age = Number.isFinite(ageMs) ? humanAge(ageMs) : "age unknown";

  // The receipt's own verdict is only half the truth. A receipt is GREEN about
  // the exact tree it ran against; once the tree moves it is a statement about
  // code that no longer exists, and reporting it as green is the same class of
  // false reassurance as "1549/1549 passing" over a login page returning 500.
  const matches = isRepo && receipt.treeHash && receipt.treeHash === treeHash();
  const passed = receipt.exitCode === 0;
  const verdict = passed ? (matches ? "GREEN" : "STALE") : matches ? "RED" : "RED (stale)";

  const suites = (receipt.suites ?? [])
    .slice(0, 3)
    .map((s) => {
      if (!s.ran) return `${s.suite} skipped`;
      return s.failed ? `${s.suite} ${s.failed} FAILED` : `${s.suite} ${s.passed ?? 0} ok`;
    })
    .join(" · ");

  const tail = matches
    ? "tree matches"
    : "receipt is for a different tree — run `pnpm test`";
  say(`tests: ${verdict} · ${age} · ${suites || "no suites recorded"} · ${tail}`);
  if (receipt.noDb) {
    say("tests: !! no DATABASE_URL when that ran — db-backed suites did not run");
  }
});

function humanAge(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Open pull requests ───────────────────────────────────────────────────────

step(() => {
  const origin = git(["remote", "get-url", "origin"]);
  // No GitHub remote means `gh` cannot answer, and asking costs a process spawn
  // plus whatever it does before failing. Worktrees and fixtures hit this path.
  if (!/github\.com|github:/i.test(origin)) return;

  let raw = "";
  try {
    raw = execFileSync("gh", ["pr", "list", "--limit", "5", "--json", "number,title,headRefName"], {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    // gh absent, unauthenticated, offline or slow. All four degrade to silence:
    // a session start must not depend on the network.
    return;
  }

  const prs = JSON.parse(raw || "[]");
  if (!Array.isArray(prs) || prs.length === 0) return;
  const shown = prs
    .slice(0, 3)
    .map((p) => `#${p.number} ${String(p.title ?? "").slice(0, 40)}`)
    .join(" · ");
  const more = prs.length > 3 ? ` (+${prs.length - 3} more)` : "";
  say(`prs: ${shown}${more}`);
});

// ── The plan in progress ─────────────────────────────────────────────────────

step(() => {
  const dir = resolve(PROJECT_DIR, "docs", "superpowers", "plans");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return;

  // "In progress" is read from the plan itself — an unchecked task box — rather
  // than from a status field someone has to remember to update. The most
  // recently touched such plan is the one this session is most likely on.
  const open = files
    .map((f) => ({ f, path: resolve(dir, f) }))
    .filter(({ path }) => /^\s*[-*] \[ \]/m.test(readFileSync(path, "utf8")))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  if (open.length === 0) return;

  const body = readFileSync(open[0].path, "utf8");
  const done = (body.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length;
  const total = done + (body.match(/^\s*[-*] \[ \]/gm) ?? []).length;
  say(`plan: ${open[0].f} (${done}/${total} tasks done)`);
});

// ── Emit ─────────────────────────────────────────────────────────────────────

// Hard cap rather than a promise to stay short: a plan filename or a PR title
// cannot push the branch and receipt lines out of view.
try {
  process.stdout.write(out.slice(0, 15).join("\n") + "\n");
} catch {
  // Even the write is guarded. A closed stdout (EPIPE) would otherwise throw
  // here, outside every step(), and turn a status line into a failed hook.
}
process.exit(0);
