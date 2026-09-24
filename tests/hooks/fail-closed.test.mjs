// A gate that cannot run must REFUSE, not wave the call through.
//
// ── THE DEFECT THIS EXISTS TO PREVENT ────────────────────────────────────────
//
// Only exit code 2 blocks a PreToolUse. Every other exit code — including 1,
// which is what node returns when it cannot find the module it was asked to
// run — allows the tool call to proceed.
//
// The hooks are registered as `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.mjs`.
// $CLAUDE_PROJECT_DIR is the directory the SESSION started in, not necessarily
// the repository: this project's sessions have been started one level above the
// repo, and that mismatch is the documented reason the previous six hooks never
// ran at all. If it resolves anywhere without a .claude/hooks directory, node
// exits 1 and the gate is silently dead — the same shape as every other defect
// this codebase has produced: a rate limiter that hung instead of failing
// closed, a health endpoint answering 200 with ok:false, a deploy probe that
// could not fail.
//
// Measured before the fix, with a `rm -rf` payload:
//
//   CLAUDE_PROJECT_DIR=<repo>  -> exit 2   blocked
//   CLAUDE_PROJECT_DIR=<other> -> exit 1   CRASH, and the rm proceeds
//
// `|| exit 2` on the blocking hooks converts any failure to load or run into a
// refusal. Advisory hooks get `|| true` instead, because a PostToolUse cannot
// undo anything and a crashing one must never wedge a session.
//
// These tests read the registration itself, because the property belongs to the
// wiring. A hook file cannot defend against never being loaded.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SETTINGS = resolve(ROOT, ".claude", "settings.json");
const HOOK_SRC = resolve(ROOT, ".claude", "hooks");

/** Every registered hook, flattened to {event, matcher, command}. */
function registrations() {
  const cfg = JSON.parse(readFileSync(SETTINGS, "utf8"));
  const out = [];
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        out.push({ event, matcher: group.matcher ?? "", command: hook.command ?? "", timeout: hook.timeout });
      }
    }
  }
  return out;
}

const BLOCKING_EVENTS = new Set(["PreToolUse"]);

/** The hook file a registration actually runs, e.g. "stop.mjs". */
function fileOf(reg) {
  const m = reg.command.match(/\.claude[\\/]hooks[\\/]([A-Za-z0-9._-]+\.mjs)/);
  return m ? m[1] : null;
}

/**
 * Whether a hook's CODE can refuse — exit 2 — as opposed to its prose saying so.
 *
 * Line comments are stripped first, and that is the whole point of this
 * function rather than a bare grep: C2 was a file whose comments described a
 * refusal at length while its registration made one impossible, and the fix
 * leaves comments behind that still name `deny()` in order to explain why it
 * is gone. Only a call in live code counts as a claim that the hook can block.
 */
function refusesInSource(src) {
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  return /\bdeny\s*\(/.test(code) || /process\.exit\(\s*2\s*\)/.test(code);
}

// ── THE SECOND DEFECT: A REGISTRATION AND A FILE THAT DISAGREE ───────────────
//
// `node … stop.mjs || true` returns 0 no matter what the script does:
//
//   $ bash -c 'node -e "process.exit(2)" || true'; echo $?
//   0
//
// So a `deny()` in stop.mjs could not block, while three separate places said
// it did — the file's own "WHY THIS ONE IS ALLOWED TO BLOCK" header and its
// three brakes, the hooks table in CLAUDE.md, and a test in session.test.mjs
// asserting exit 2 from a BARE `node stop.mjs`. Measured on the code as it
// stood, with uncommitted apps/** and no receipt:
//
//   node .claude/hooks/stop.mjs                  -> exit 2   (what the file said)
//   bash -c 'node … stop.mjs || true'            -> exit 0   (what Claude Code saw)
//
// Every test in the suite passed throughout, because they tested the two halves
// separately: this file read the registration, session.test.mjs spawned the
// file, and NOTHING ran the file through the registered command shape. These
// two tests are that missing pair — one static across every hook, one executed
// end to end — and they are what makes a future disagreement impossible to
// commit rather than merely discouraged.

test("a hook whose code can refuse is never registered behind `|| true`", () => {
  const checked = [];
  for (const r of registrations()) {
    const file = fileOf(r);
    assert.ok(file, `cannot tell which hook file runs: ${r.command}`);
    if (!refusesInSource(readFileSync(resolve(HOOK_SRC, file), "utf8"))) continue;
    checked.push(file);
    assert.doesNotMatch(
      r.command,
      /\|\|\s*true\s*$/,
      `${file} calls deny()/exit 2, but its ${r.event} registration ends in \`|| true\`, which ` +
        `turns every refusal into exit 0. Either the refusal is real — then drop \`|| true\` — or ` +
        `it is not, and the code must go. Command: ${r.command}`,
    );
  }
  assert.ok(checked.length >= 2, `expected to find refusing hooks to check, found ${checked.join(", ") || "none"}`);
});

/** Fixture directories made by the executed pair test, removed once at the end. */
const temps = [];

after(() => {
  for (const dir of temps) {
    // maxRetries: on Windows a just-exited git process can hold .git briefly.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A leaked temp directory is not worth failing a suite over.
    }
  }
});

/**
 * A throwaway repository holding a copy of every hook.
 *
 * _lib.mjs derives PROJECT_DIR from the hook file's OWN location, so the copy
 * is rooted here and writes only here. The real repository is read, never
 * touched: nothing commits, stashes or pushes, and `git init` is the only git
 * command run.
 */
function hookSandbox(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gml-agree-"));
  temps.push(dir);
  spawnSync("git", ["init", "-b", "feat/agree"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOK_SRC)) cpSync(join(HOOK_SRC, f), join(dir, ".claude", "hooks", f));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

test("the Stop hook's registration and its file agree about whether it can block", () => {
  const reg = registrations().find((r) => r.event === "Stop");
  assert.ok(reg, "there must be a Stop registration");

  const fileCanBlock = refusesInSource(readFileSync(resolve(HOOK_SRC, "stop.mjs"), "utf8"));

  // The payload the old gate existed for: uncommitted source, no receipt. If
  // stop.mjs can refuse at all, it refuses on this one — so this is the input
  // that tells the two halves apart.
  const dir = hookSandbox({ "apps/web/x.ts": "export const x = 1;\n" });
  const r = spawnSync("bash", ["-c", reg.command], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GML_GATE_SKIP: "" },
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s-agree" }),
  });

  assert.equal(
    r.status,
    fileCanBlock ? 2 : 0,
    `stop.mjs ${fileCanBlock ? "calls deny(), so it claims it can block" : "has no refusal path, so it claims it cannot block"}, ` +
      `but running its REGISTERED command shape gave exit ${r.status}.\n` +
      `registration: ${reg.command}\nstderr:\n${r.stderr}`,
  );

  if (fileCanBlock) {
    assert.doesNotMatch(reg.command, /\|\|\s*true\s*$/, "a Stop hook meant to block cannot be registered `|| true`");
  } else {
    // A recorder that records nothing is the failure this hook was written to
    // end: the script it replaces appended unconditionally and still left
    // session_log.md at 112 bytes, because it never ran. Assert the ledger.
    const ledger = join(dir, "workspace", "session_log.md");
    const rows = readFileSync(ledger, "utf8").split(/\r?\n/).filter((l) => l.startsWith("- "));
    assert.equal(rows.length, 1, `the registered command must still write the ledger line; got:\n${rows.join("\n")}`);
  }
});

test("every blocking hook is registered to fail CLOSED", () => {
  const blocking = registrations().filter((r) => BLOCKING_EVENTS.has(r.event));
  assert.ok(blocking.length >= 2, `expected PreToolUse registrations, found ${blocking.length}`);

  for (const r of blocking) {
    assert.match(
      r.command,
      /\|\|\s*exit\s+2\s*$/,
      `${r.event} (${r.matcher}) must end with \`|| exit 2\`. Without it, a hook that fails to ` +
        `load exits 1 — which does NOT block — and the gate is silently dead. Command: ${r.command}`,
    );
  }
});

test("every advisory hook is registered so a crash cannot wedge the session", () => {
  const advisory = registrations().filter((r) => !BLOCKING_EVENTS.has(r.event));
  assert.ok(advisory.length >= 3, `expected advisory registrations, found ${advisory.length}`);

  for (const r of advisory) {
    assert.match(
      r.command,
      /\|\|\s*true\s*$/,
      `${r.event} (${r.matcher}) is advisory — a PostToolUse cannot undo the call, and Stop is a ` +
        `recorder whose crash must not leave a session unendable — so it must end with \`|| true\`. ` +
        `Command: ${r.command}`,
    );
  }
});

test("a blocking hook whose file is missing still refuses the call", () => {
  // The whole point, executed rather than reasoned about: run the REGISTERED
  // command shape with a project directory that has no .claude/hooks, and
  // require a refusal.
  const reg = registrations().find((r) => r.event === "PreToolUse" && r.matcher === "Bash");
  assert.ok(reg, "there must be a PreToolUse Bash registration");

  const r = spawnSync("bash", ["-c", reg.command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: resolve(ROOT, "..", "..", "__no_such_project__") },
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules" },
    }),
  });

  assert.equal(
    r.status,
    2,
    `an unloadable gate must refuse (exit 2), not crash (exit 1) and let the command run. ` +
      `Got exit ${r.status}.\nstderr:\n${r.stderr}`,
  );
});

test("a loadable blocking hook still refuses a destructive command", () => {
  // Guards against the lazy fix: `|| exit 2` would also "pass" this file if the
  // hook were deleted entirely. Requiring a real refusal from a real hook, with
  // a reason on stderr, keeps both halves honest.
  const reg = registrations().find((r) => r.event === "PreToolUse" && r.matcher === "Bash");
  const r = spawnSync("bash", ["-c", reg.command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules" },
    }),
  });

  assert.equal(r.status, 2, `a destructive command must be refused. stderr:\n${r.stderr}`);
  assert.ok(
    (r.stderr ?? "").trim().length > 0,
    "a refusal must say why — a gate that blocks silently gets disabled rather than satisfied",
  );
});

test("a loadable blocking hook allows an ordinary command", () => {
  // The other direction: if `|| exit 2` were applied to something that always
  // failed, every Bash call would be blocked and the layer would be removed
  // within the hour. Fail-closed must not mean closed-always.
  const reg = registrations().find((r) => r.event === "PreToolUse" && r.matcher === "Bash");
  const r = spawnSync("bash", ["-c", reg.command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    }),
  });

  assert.equal(r.status, 0, `an ordinary command must pass. stderr:\n${r.stderr}`);
});

test("the Bash gate's timeout is bounded to something a session can absorb", () => {
  // It shells out to `gh pr view` on a merge, capped internally at 20s. A
  // 120-second ceiling means a hung gh stalls the session for two minutes on a
  // hook written to a sub-second budget.
  const reg = registrations().find((r) => r.event === "PreToolUse" && r.matcher === "Bash");
  assert.ok(
    typeof reg.timeout === "number" && reg.timeout > 0 && reg.timeout <= 60,
    `the PreToolUse Bash hook needs a timeout of 60s or less; found ${JSON.stringify(reg.timeout)}`,
  );
});
