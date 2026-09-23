import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SMOKE = "tests/integration/smoke.test.mjs";
const SPEC_DIR = "specs/111-integration-smoke";
const PKG = "package.json";

test("spec 111: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 111: integration smoke file exists at the canonical path", () => {
  assert.ok(
    existsSync(resolve(root, SMOKE)),
    `${SMOKE} must exist — the first behavioural (non-grep) test in the repo`,
  );
});

test("spec 111: smoke imports from node:test and uses global fetch", () => {
  const src = read(SMOKE);
  // Must use node:test idiom (matches governance tests, no new dependencies).
  assert.match(
    src,
    /from\s+["']node:test["']/,
    "smoke must import its test runner from 'node:test'",
  );
  // Must call fetch — this is what distinguishes a behavioural test from a
  // grep test. We accept either bare `fetch(` or `globalThis.fetch(`.
  assert.match(
    src,
    /\b(globalThis\.)?fetch\s*\(/,
    "smoke must call fetch() to exercise the running app via real HTTP",
  );
});

test("spec 111: smoke references at least 4 distinct /api/... endpoints", () => {
  const src = read(SMOKE);
  // Pull out every /api/... path mentioned in the file and de-dupe.
  const matches = src.match(/\/api\/[a-zA-Z0-9_\-/[\]]+/g) ?? [];
  const distinct = new Set(matches);
  assert.ok(
    distinct.size >= 4,
    `smoke must reference at least 4 distinct /api/... endpoints, saw ${distinct.size}: ${[...distinct].join(", ")}`,
  );
});

test("spec 111: smoke FAILS when the target is unreachable", () => {
  // INVERTED, and this is the sharpest inversion in the repo.
  //
  // This test used to REQUIRE a skip-when-unreachable path, on the reasoning
  // that CI environments which do not boot the stack should stay green. That
  // reasoning produced a suite that was structurally incapable of failing:
  // `node --test` exits 0 when everything skips, and CI ran it with `|| true`
  // on top of that. It reported green whether the deployment worked or not --
  // the same defect the governance suite has, one layer up.
  //
  // It now fails loudly, and scripts/deploy.sh runs it against the deployment
  // it has just made, where a full stack genuinely exists. CI's executable
  // coverage moved to `pnpm test:behaviour`, which runs against a real Postgres
  // service container and needs no booted application.
  const src = read(SMOKE);

  assert.match(
    src,
    /SMOKE_BASE_URL/,
    "an operator must be able to target a specific deployment",
  );
  assert.match(src, /\/api\/health/, "the reachability probe is /api/health");
  assert.match(
    src,
    /assert\.fail\(/,
    "unreachable must be a FAILURE. A suite that skips instead is not evidence " +
      "that anything works, and this one spent its whole life being green " +
      "without testing a thing.",
  );
  assert.ok(
    !/t\.skip\s*\(|ctx\.skip\s*\(/.test(src),
    "no per-test skip path may return -- it is what made the suite unfalsifiable",
  );
});

test("spec 111: smoke bounds every probe so a hung server cannot hang the suite", () => {
  const src = read(SMOKE);
  // AbortSignal.timeout() replaces the hand-rolled AbortController +
  // setTimeout pair. Same property, one line, and no timer to leak.
  assert.match(
    src,
    /AbortSignal\.timeout\(|AbortController/,
    "probes must be time-bounded",
  );
});

test("spec 111: top-level package.json has a 'test:smoke' script", () => {
  const pkg = JSON.parse(read(PKG));
  assert.ok(pkg.scripts, "package.json must have a scripts block");
  assert.ok(
    typeof pkg.scripts["test:smoke"] === "string",
    "package.json scripts must include 'test:smoke' so operators can run the smoke suite",
  );
  // The script must reference node --test (no new dependency) and target the
  // integration folder.
  assert.match(
    pkg.scripts["test:smoke"],
    /node\s+--test/,
    "'test:smoke' must use `node --test` (same runner as governance, no new deps)",
  );
  assert.match(
    pkg.scripts["test:smoke"],
    /tests\/integration/,
    "'test:smoke' must target tests/integration/",
  );
});

test("spec 111: default 'test' script does NOT run the smoke folder", () => {
  const pkg = JSON.parse(read(PKG));

  // ── WHY THIS RESOLVES THE SCRIPT CHAIN ────────────────────────────────────
  //
  // This used to regex `pkg.scripts.test` for the literal "tests/governance".
  // That pinned ONE IMPLEMENTATION of the property rather than the property:
  // the moment `test` became a fan-out (`pnpm run test:governance && pnpm run
  // test:scripts`) the assertion failed, though the thing it exists to prevent
  // -- `pnpm test` reaching for a live stack -- was still true.
  //
  // Worse, it failed OPEN in the other direction: `test: "pnpm run everything"`
  // where `everything` ran tests/integration would have passed the old check,
  // because the forbidden string was not in the `test` field itself.
  //
  // So: resolve `pnpm run <name>` / `npm run <name>` transitively and assert
  // over the whole closure. Following the indirection is what makes this a
  // guard rather than a spelling check.
  // Four forms a first version of this walker missed, each of which would have
  // let tests/integration back in silently:
  //
  //   pnpm test:smoke            `run` is optional in pnpm -- and this is the
  //                              form the repo itself uses, at deploy.sh:281
  //   pnpm -s run test:smoke     flags between the binary and the script name
  //   posttest                   npm/pnpm lifecycle; runs automatically and
  //                              appears in no other script's body
  //   run-s test:smoke           npm-run-all, if it is ever added
  //
  // The regex therefore makes `run` optional and tolerates flags, and the walk
  // is seeded with the lifecycle triple rather than `test` alone.
  const scripts = pkg.scripts ?? {};
  const resolved = new Set();
  const commands = [];
  const REF =
    /(?:^|[;&|]|\s)(?:(?:pnpm|npm|yarn)(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+(?:run\s+)?|run-[sp]\s+)([\w:-]+)/g;
  const walk = (name) => {
    if (resolved.has(name)) return; // cycles and diamonds
    resolved.add(name);
    const body = scripts[name];
    if (typeof body !== "string") return;
    commands.push(body);
    for (const m of body.matchAll(REF)) walk(m[1]);
  };
  for (const entry of ["pretest", "test", "posttest"]) walk(entry);
  const closure = commands.join(" ; ");

  assert.ok(
    /tests\/governance/.test(closure),
    `\`pnpm test\` must run the governance suite somewhere in its chain. Resolved: ${closure}`,
  );
  assert.ok(
    !/tests\/integration/.test(closure),
    `\`pnpm test\` must not reach tests/integration -- smoke needs a running deployment and is opt-in via test:smoke. ` +
      `Resolved chain (${[...resolved].join(" -> ")}): ${closure}`,
  );
});

test("spec 111: smoke covers the endpoints that exist now", () => {
  const src = read(SMOKE);
  // The old list pinned /api/auth/csrf and /api/auth/callback/credentials --
  // Auth.js endpoints deleted with Auth.js. A test that requires a suite to
  // probe routes which no longer exist does not protect coverage; it prevents
  // the suite from being corrected.
  for (const path of [
    "/api/health",
    "/login",
    "/dashboard",
    "/admin/users",
    "/api/webhooks/whatsapp",
  ]) {
    assert.ok(src.includes(path), `smoke must exercise ${path}`);
  }

  // And it must assert the deleted ones are GONE, which is the stronger
  // property: a route that still answers after being "removed" is a live
  // surface nobody is maintaining.
  for (const gone of ["/api/auth/csrf", "/api/uploads/tus"]) {
    assert.ok(
      src.includes(gone),
      `smoke must confirm ${gone} no longer exists`,
    );
  }
});

test("spec 111: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
