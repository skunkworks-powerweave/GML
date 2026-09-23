// Governance test for spec 001 — harness scaffold.
// Asserts the seed structure declared in specs/001-harness-scaffold/spec.md FR-001 .. FR-010.
// TDD: write first (red), then create files (green).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(root, rel), "utf8"));
}

test("FR-002: root package.json declares pnpm workspaces and pnpm@10 packageManager", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.private, true, "root package.json must be private");
  assert.ok(Array.isArray(pkg.workspaces), "workspaces must be an array");
  assert.ok(pkg.workspaces.includes("apps/*"), "must include apps/*");
  assert.ok(pkg.workspaces.includes("packages/*"), "must include packages/*");
  assert.match(pkg.packageManager ?? "", /^pnpm@10\./, "packageManager must be pnpm@10.x");
});

test("FR-002: pnpm-workspace.yaml exists", () => {
  assert.ok(existsSync(resolve(root, "pnpm-workspace.yaml")), "pnpm-workspace.yaml must exist");
});

test("FR-003: apps/web is a valid workspace named @gml/web", () => {
  const pkg = readJson("apps/web/package.json");
  assert.equal(pkg.name, "@gml/web", "apps/web/package.json name must be @gml/web");
});

test("FR-004: empty workspaces packages/{db,ui,shared} are valid", () => {
  for (const sub of ["db", "ui", "shared"]) {
    const pkg = readJson(`packages/${sub}/package.json`);
    assert.equal(pkg.name, `@gml/${sub}`, `packages/${sub}/package.json name`);
    assert.equal(pkg.private, true);
  }
});

test("FR-005: apps/worker stub exists", () => {
  const pkg = readJson("apps/worker/package.json");
  assert.equal(pkg.name, "@gml/worker");
});

test("FR-006: .claude/settings.json wires six hooks that can actually fire", () => {
  const cfg = readJson(".claude/settings.json");
  assert.ok(cfg.hooks, "hooks block must exist");

  // ── REWRITTEN, BECAUSE THE OLD SHAPE COUNTED HOOKS THAT DID NOTHING ───────
  //
  // This used to require `PreToolUse.length >= 3`. Three existed: Bash, plus
  // two scoped with a `pathGlob` key. `pathGlob` is not a hook-config field --
  // it appears ZERO times in the installed Claude Code binary -- so those two
  // fired on every Edit/Write and, being `exit 0` reminders, changed nothing.
  // The assertion was counting a design that had never worked.
  //
  // What matters is that each EVENT is wired, that the commands point at the
  // shared hooks directory, and that no dead config field has crept back.
  // Whether each hook enforces its rule is tested by executing it, in
  // tests/hooks/ -- which is where behaviour belongs.
  for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
    assert.ok(Array.isArray(cfg.hooks[event]), `${event} must be registered`);
  }

  const all = [];
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    for (const g of groups) {
      assert.ok(
        !("pathGlob" in g),
        `${event} uses \`pathGlob\`, which is not a real config field -- the hook would ` +
          `fire for every matching tool call regardless. Filter on tool_input.file_path ` +
          `inside the hook instead.`,
      );
      for (const h of g.hooks ?? []) all.push({ event, matcher: g.matcher ?? "", ...h });
    }
  }

  assert.equal(all.length, 6, `expected six hooks, found ${all.length}`);
  for (const h of all) {
    assert.match(
      h.command ?? "",
      /\.claude\/hooks\/[a-z-]+\.mjs/,
      `${h.event} must run a hook from .claude/hooks/. Command: ${h.command}`,
    );
  }

  // Only exit code 2 blocks a PreToolUse; a hook that fails to load exits 1 and
  // the call proceeds. See tests/hooks/fail-closed.test.mjs for the executed
  // proof -- this is the structural half.
  for (const h of all.filter((x) => x.event === "PreToolUse")) {
    assert.match(
      h.command,
      /\|\|\s*exit\s+2\s*$/,
      `${h.event} (${h.matcher}) must fail CLOSED. Command: ${h.command}`,
    );
  }
});

test("FR-007: workspace/state.json has a valid current spec pointer", (t) => {
  // workspace/ is PER-MACHINE RUNTIME STATE for the local agent harness, and
  // .gitignore excludes it (not even workspace/.gitkeep is tracked). Asserting
  // it exists made this suite pass on a developer box and fail on every fresh
  // clone -- which is exactly what happened on this repository's first-ever CI
  // run, with ENOENT on workspace/state.json. A gate that only passes where the
  // scratch files happen to exist is not a gate. Skip when absent; still verify
  // the contents when a developer does have it.
  if (!existsSync(resolve(root, "workspace/state.json"))) {
    t.skip("workspace/ is gitignored runtime state — absent on a clean checkout");
    return;
  }
  const state = readJson("workspace/state.json");
  assert.match(String(state.currentSpec), /^\d{3}$/, "currentSpec must be 3-digit string");
  // specsTotal grew from v1's 70 → v2's 95 (spec 013 amendment). Keep it loose.
  assert.equal(typeof state.specsTotal, "number", "specsTotal must be a number");
  assert.ok(state.specsTotal >= 70, "specsTotal must be at least 70 (v1 floor)");
  assert.equal(typeof state.specsCompleted, "number", "specsCompleted must be a number");
});

test("FR-007: the session ledger is written by a hook, not asserted into existence", () => {
  // ── INVERTED ──────────────────────────────────────────────────────────────
  //
  // This used to assert that workspace/session_log.md and marathon_log.md
  // exist. Both did. Both were EMPTY -- session_log.md was 112 bytes of header
  // across eleven sessions and 27 commits, and marathon_log.md never recorded
  // one of the sixteen "workflow runs" it was created for.
  //
  // That is how we know the old Stop hook never ran: scripts/stop_session.mjs
  // appended unconditionally, so a single execution would have left a line.
  // A test asserting the file exists passed the whole time.
  //
  // So assert the thing that produces the ledger instead. `workspace/` is
  // gitignored runtime state and is correctly absent from a clean checkout.
  const cfg = readJson(".claude/settings.json");
  const stop = (cfg.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []);
  assert.equal(stop.length, 1, "exactly one Stop hook must be registered");
  assert.match(stop[0].command ?? "", /stop\.mjs/, "the Stop hook must run .claude/hooks/stop.mjs");

  const src = readFileSync(resolve(root, ".claude/hooks/stop.mjs"), "utf8");
  assert.match(
    src,
    /session_log\.md/,
    "the Stop hook must write workspace/session_log.md -- the ledger that stayed empty for the " +
      "life of the project because its hook never fired",
  );
});

test("FR-008: the session-start hook lives in .claude/hooks, and the dead ones are gone", () => {
  assert.ok(
    existsSync(resolve(root, ".claude/hooks/session-start.mjs")),
    "the SessionStart hook moved to .claude/hooks/session-start.mjs alongside the others",
  );

  // The six scripts it replaces are deleted, and must stay deleted. They are
  // not merely superseded: every one of them was inert. block_destructive.mjs
  // read process.argv[2] for a payload that arrives on stdin, so the only
  // blocking hook in the project never matched anything; three were `exit 0`
  // reminders scoped by a config field that does not exist; and the Stop hook
  // never fired at all.
  for (const gone of [
    "scripts/session_start.mjs",
    "scripts/stop_session.mjs",
    "scripts/block_destructive.mjs",
    "scripts/warn_schema_change.mjs",
    "scripts/warn_middleware_change.mjs",
    "scripts/check_migration_reversible.mjs",
  ]) {
    assert.ok(
      !existsSync(resolve(root, gone)),
      `${gone} must not come back -- it enforced nothing and its presence implies otherwise`,
    );
  }
});

test("FR-009: CLAUDE.md exists with project context sections", () => {
  const md = readFileSync(resolve(root, "CLAUDE.md"), "utf8");
  for (const section of ["Project", "Plan", "Specs", "Harness", "Hooks", "Folder map"]) {
    assert.match(md, new RegExp(section, "i"), `CLAUDE.md must reference ${section}`);
  }
});

test("FR-010: placeholder docs and root files exist", () => {
  for (const f of [
    "README.md",
    "README-IT.md",
    ".env.example",
    ".gitignore",
    "docs/substrate-moats.md",
    "docs/verification.md",
    "docs/architecture.md",
    "docs/operations.md",
  ]) {
    assert.ok(existsSync(resolve(root, f)), `${f} must exist`);
  }
});

test("FR-012: .gitignore covers the right paths", () => {
  const gi = readFileSync(resolve(root, ".gitignore"), "utf8");
  for (const pattern of ["node_modules", ".next", "workspace", ".env"]) {
    assert.match(gi, new RegExp(pattern), `.gitignore must include ${pattern}`);
  }
});
