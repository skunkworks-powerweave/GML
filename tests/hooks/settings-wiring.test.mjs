// Wiring tests: the registration layer, not the hook bodies.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// Every hook in this project was correct-looking and dead. Not one of them ever
// ran, and the reason was never inside a hook body — it was in the wiring:
//
//   * `.claude/settings.json` passed `"$TOOL_INPUT"` as argv[2]. That variable
//     appears ZERO times in the installed Claude Code binary, so the single
//     blocking hook compared an empty string against its patterns forever.
//   * Three registrations carried a `pathGlob` key. Also zero occurrences —
//     not a config field. Those hooks fired on every Edit/Write instead of on
//     the paths they named, and their authors never learned it.
//
// The proof is `workspace/session_log.md`: `scripts/stop_session.mjs` appends
// to it unconditionally, and it sat at 112 bytes — header only — across the
// sessions that produced 27 commits.
//
// So the hook suites owned by the hook files test what a hook DOES. This file
// tests that the hook is reachable at all, because a perfect hook at a path
// nothing invokes is the exact defect this project already shipped.
//
// The hook bodies are deliberately NOT executed here. `node --check` proves the
// registered path resolves and parses without running a module that may append
// to workspace/ or shell out to git; observable behaviour belongs to each
// hook's own suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const SETTINGS = ".claude/settings.json";
const WORKFLOW = ".github/workflows/test.yml";
const PR_TEMPLATE = ".github/pull_request_template.md";

/** Parse settings.json. A throw here IS the failure — a broken file loads no hooks. */
function settings() {
  return JSON.parse(read(SETTINGS));
}

/**
 * Flatten the registration tree into one row per command.
 *
 * Claude Code accepts two shapes under an event: a bare hook object, or a
 * matcher group wrapping a `hooks` array. The old file mixed both, which is
 * legal but made the three broken registrations easy to skim past.
 */
function registrations(cfg) {
  const rows = [];
  for (const [event, entries] of Object.entries(cfg.hooks ?? {})) {
    for (const entry of entries ?? []) {
      const group = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const hook of group) {
        rows.push({ event, matcher: entry.matcher ?? null, ...hook });
      }
    }
  }
  return rows;
}

/**
 * Split the workflow's `jobs:` block into {id, name, body}.
 *
 * A YAML parser would be a new dependency, and this repo has none. Two-space
 * indentation for job ids and four for their keys is already enforced by the
 * file being valid YAML that GitHub accepts.
 */
function workflowJobs(src) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "workflow must have a top-level `jobs:` block");
  const jobs = new Map();
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // dedented out of jobs:
    const id = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (id) {
      cur = { id: id[1], name: null, body: [] };
      jobs.set(cur.id, cur);
      continue;
    }
    if (!cur) continue;
    cur.body.push(line);
    const named = line.match(/^ {4}name:\s*(.+?)\s*$/);
    if (named) cur.name = named[1];
  }
  return jobs;
}

// ─── settings.json ───────────────────────────────────────────────────────────

test("settings.json registers all six hooks on the right events and matchers", () => {
  const rows = registrations(settings());
  const seen = rows.map((r) => `${r.event} ${r.matcher ?? "*"} -> ${r.command}`);

  const expected = [
    ["SessionStart", "startup|resume|clear|compact", "session-start"],
    ["PreToolUse", "Bash", "pre-bash"],
    ["PreToolUse", "Edit|Write|MultiEdit", "pre-edit"],
    ["PostToolUse", "Edit|Write|MultiEdit", "post-edit"],
    ["PostToolUse", "Bash", "post-bash"],
    ["Stop", null, "stop"],
  ];

  assert.equal(
    rows.length,
    expected.length,
    `expected exactly ${expected.length} hook commands, got ${rows.length}:\n${seen.join("\n")}`,
  );

  for (const [event, matcher, hookName] of expected) {
    const hit = rows.find(
      (r) => r.event === event && r.matcher === matcher && r.command?.includes(`${hookName}.mjs`),
    );
    assert.ok(
      hit,
      `no registration for ${event} matcher=${matcher ?? "(none)"} -> .claude/hooks/${hookName}.mjs\nhave:\n${seen.join("\n")}`,
    );
    assert.equal(hit.type, "command", `${hookName} registration must be type "command"`);
    // The documented form, PLUS a mandatory failure suffix.
    //
    // PROJECT_DIR is re-derived inside _lib.mjs from the hook's own location
    // precisely because this variable is the directory the SESSION started in
    // and need not be the repository. But that only helps once the file is
    // RUNNING: if the path does not resolve, node exits 1, and exit 1 does not
    // block — the tool call proceeds and the gate is silently dead. Measured
    // with a `rm -rf` payload before the suffix was added:
    //
    //   CLAUDE_PROJECT_DIR=<repo>  -> exit 2   blocked
    //   CLAUDE_PROJECT_DIR=<other> -> exit 1   crash, and the rm runs
    //
    // So a blocking hook must end `|| exit 2` and an advisory one `|| true`.
    // tests/hooks/fail-closed.test.mjs proves both by execution; this pins the
    // registration shape that makes it possible.
    const suffix = hit.event === "PreToolUse" ? String.raw`\|\| exit 2` : String.raw`\|\| true`;
    assert.match(
      hit.command,
      new RegExp(String.raw`^node "\$CLAUDE_PROJECT_DIR"/\.claude/hooks/[a-z-]+\.mjs ${suffix}$`),
      `${hookName} command must be \`node "$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.mjs\` followed by ` +
        `${hit.event === "PreToolUse" ? "`|| exit 2` (fail closed)" : "`|| true` (advisory, never wedge a session)"}` +
        `, got: ${hit.command}`,
    );
  }
});

test("every registered hook command resolves to a file that exists and parses", () => {
  // The defect this pins: a registration naming a path that is not there fails
  // SILENTLY. Claude Code does not announce a hook it could not launch, which
  // is why six dead hooks survived 27 commits unnoticed.
  for (const row of registrations(settings())) {
    const rel = row.command.match(/\.claude\/hooks\/[a-z-]+\.mjs/)?.[0];
    assert.ok(rel, `command does not name a hook file: ${row.command}`);
    const abs = resolve(ROOT, rel);
    assert.ok(existsSync(abs), `${row.event} hook is registered at ${rel}, which does not exist`);
    const checked = spawnSync(process.execPath, ["--check", abs], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(checked.status, 0, `${rel} does not parse:\n${checked.stderr}`);
  }
});

test("settings.json carries no pathGlob key and no $TOOL_INPUT reference", () => {
  const raw = read(SETTINGS);
  // Both were verified against the installed binary: zero occurrences each.
  // Leaving either in place is worse than removing the hook, because it reads
  // as enforcement to the next person to open the file.
  assert.ok(
    !raw.includes("pathGlob"),
    "`pathGlob` is not a Claude Code config field — it never filtered anything. A hook that cares about paths must read tool_input.file_path itself.",
  );
  assert.ok(
    !raw.includes("TOOL_INPUT"),
    "$TOOL_INPUT does not exist. Hook payloads arrive as JSON on stdin; _lib.mjs readInput() is the only correct reader.",
  );
});

test("the six dead scripts/*.mjs hook scripts are deleted, not left as decoration", () => {
  for (const dead of [
    "session_start.mjs",
    "stop_session.mjs",
    "block_destructive.mjs",
    "warn_schema_change.mjs",
    "warn_middleware_change.mjs",
    "check_migration_reversible.mjs",
  ]) {
    assert.ok(
      !existsSync(resolve(ROOT, "scripts", dead)),
      `scripts/${dead} is superseded by .claude/hooks/ and must be removed — a second, unreachable copy of a gate is how a reader concludes the gate exists.`,
    );
  }
});

test("the Bash hooks get a bounded timeout — long enough to finish, short enough to notice", () => {
  // ── TWO FAILURE MODES, PULLING OPPOSITE WAYS ──────────────────────────────
  //
  // TOO SHORT: a timed-out hook has its output DISCARDED and no decision
  // applied, which means the tool call proceeds. A gate killed mid-run is a
  // gate that let the commit through — the same fail-open shape as a hook that
  // cannot load at all (see tests/hooks/fail-closed.test.mjs).
  //
  // TOO LONG: this originally asserted exactly 120. A hung `gh pr view` would
  // then stall the session for two full minutes, on hooks written to a
  // sub-second budget — and a gate that makes the session feel broken gets
  // removed, which is fail-open by another route.
  //
  // The longest legitimate path is pre-bash's merge rule, which shells out to
  // `gh pr view` under an internal 20s cap, plus a handful of git calls capped
  // at 15s each. 60s clears that with room and is not a stall anyone will sit
  // through twice. Asserted as a RANGE rather than a magic number, so the
  // reasoning survives the next edit.
  const bash = registrations(settings()).filter((r) => /pre-bash|post-bash/.test(r.command));
  // Counted, not just iterated. The first draft of this test looped over zero
  // rows and reported green — the same shape of nothing-assertion as the hooks
  // it is here to replace.
  assert.equal(bash.length, 2, "expected both pre-bash and post-bash to be registered");
  for (const row of bash) {
    assert.equal(
      typeof row.timeout,
      "number",
      `${row.command} must declare an explicit timeout — the default is not chosen for this gate`,
    );
    assert.ok(
      row.timeout >= 30 && row.timeout <= 60,
      `${row.command} timeout is ${row.timeout}s; expected 30-60. Below 30 risks killing the ` +
        `merge rule's gh call mid-flight (fails OPEN); above 60 is a stall long enough that ` +
        `someone disables the layer (also fails open).`,
    );
  }
});

// ─── .github/workflows/test.yml ──────────────────────────────────────────────

test("CI job check names are plain ASCII ids branch protection can require", () => {
  const jobs = workflowJobs(read(WORKFLOW));
  for (const id of ["static", "behaviour", "images"]) {
    const job = jobs.get(id);
    assert.ok(job, `workflow must define a job id \`${id}\`; have: ${[...jobs.keys()].join(", ")}`);
    // GitHub shows `name:` when set and the job id otherwise, and branch
    // protection matches that displayed string literally. `lint · typecheck ·
    // build · governance` cannot be typed into the required-checks box
    // reliably — U+00B7 and parentheses make the rule unmatchable, so the
    // protection silently requires nothing.
    const displayed = job.name ?? job.id;
    assert.equal(
      displayed,
      id,
      `job \`${id}\` displays as "${displayed}" — branch protection requires checks by that exact string, so it must be the bare ASCII id`,
    );
    assert.ok(
      /^[a-z]+$/.test(displayed),
      `job check name "${displayed}" must be plain lowercase ASCII (no "·", no parentheses)`,
    );
  }
});

test("the behaviour job pins ONE Postgres major, and it is the newer one", () => {
  const jobs = workflowJobs(read(WORKFLOW));
  const body = jobs.get("behaviour")?.body.join("\n") ?? "";
  // This test was called "matches production" and its message said "production
  // is Postgres 17". Nothing in this repository records the version Supabase
  // runs — the claim was withdrawn from CLAUDE.md and the CI comment in the same
  // round, and survived here, in the assertion message, where a withdrawn claim
  // is load-bearing for anyone who reads a failure.
  //
  // What is left is a real invariant with an honest reason: the job must pin an
  // exact major (not `postgres:alpine`, which moves under the suite), and 17 is
  // the choice on record. If the deployment's version is ever read off Supabase
  // and it is not 17, this test is where that lands.
  assert.match(
    body,
    /image:\s*postgres:17-alpine\b/,
    "behaviour job must pin postgres:17-alpine; the major has to be explicit so the suite cannot silently change databases underneath itself",
  );
  assert.ok(
    !/postgres:16/.test(body),
    "no postgres:16 image may remain in the behaviour job",
  );
});

test("the static job enforces the shell executable bit and runs the hook suite", () => {
  const jobs = workflowJobs(read(WORKFLOW));
  const body = jobs.get("static")?.body.join("\n") ?? "";
  // scripts/*.sh are the deploy/backup/restore path. A 100644 mode there is
  // invisible in a diff and turns `./scripts/restore.sh` into "Permission
  // denied" on the one day it is run.
  assert.match(
    body,
    /git ls-files -s scripts\/\*\.sh/,
    "static job must fail when any scripts/*.sh is not mode 100755",
  );
  assert.match(
    body,
    /pnpm test:hooks/,
    "static job must run `pnpm test:hooks` — the enforcement layer is the one thing no other lane exercises",
  );
});

// ─── .github/pull_request_template.md ────────────────────────────────────────

test("the PR template demands every piece of evidence the merge gate greps for", () => {
  assert.ok(
    existsSync(resolve(ROOT, PR_TEMPLATE)),
    `${PR_TEMPLATE} must exist — the review gate has nothing to read otherwise`,
  );
  const src = read(PR_TEMPLATE);
  for (const [label, re] of [
    ["Plan link", /Plan link/i],
    ["RED evidence", /RED evidence/i],
    ["the literal `not ok` line", /not ok/],
    ["receipt timestamp", /receipt timestamp/i],
    ["GREEN evidence", /GREEN evidence/i],
    ["Mutation check", /Mutation check/i],
    ["Review", /^#+\s*Review\b/m],
    ["Verification commands", /Verification commands/i],
    ["Overrides used", /Overrides used/i],
    ["GML_GATE_SKIP", /GML_GATE_SKIP/],
  ]) {
    assert.match(src, re, `${PR_TEMPLATE} must ask for: ${label}`);
  }
  // The merge hook greps for this literal string. If the template ever stops
  // carrying it verbatim, every PR fails review for a reason nobody can see —
  // so the exact token is pinned here rather than described.
  assert.match(
    src,
    /^Review-Verdict:/m,
    "template must contain a literal `Review-Verdict:` line at column 0 — the merge hook greps for `Review-Verdict: approved`",
  );
});
