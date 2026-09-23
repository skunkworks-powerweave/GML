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

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SETTINGS = resolve(ROOT, ".claude", "settings.json");

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
      `${r.event} (${r.matcher}) is advisory — a PostToolUse cannot undo the call and Stop must ` +
        `never loop — so it must end with \`|| true\`. Command: ${r.command}`,
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
