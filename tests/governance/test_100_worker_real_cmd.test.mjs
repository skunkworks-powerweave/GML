// Governance test for spec 100 — worker container real CMD (BullMQ consumer entrypoint).
//
// Asserts that docker/worker.Dockerfile no longer ships the placeholder idle
// loop from spec 002 and instead invokes the real worker module on container
// start. We do not run docker here — these are static-file shape checks that
// would have caught the original deployment blocker in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

test("FR-001: placeholder 'worker idle' console.log is gone", () => {
  const df = readText("docker/worker.Dockerfile");
  assert.doesNotMatch(
    df,
    /console\.log\(\s*['"]worker idle/,
    "placeholder 'console.log('worker idle …')' must be removed from CMD",
  );
  assert.doesNotMatch(
    df,
    /worker idle/,
    "the literal string 'worker idle' must not appear anywhere in worker.Dockerfile",
  );
});

test("FR-002: CMD invokes the real worker entrypoint (tsx / node / pnpm)", () => {
  const df = readText("docker/worker.Dockerfile");
  // Find every CMD instruction (there should be exactly one at the bottom).
  const cmdLines = df.split(/\r?\n/).filter((l) => /^\s*CMD\s/.test(l));
  assert.equal(cmdLines.length, 1, `expected exactly 1 CMD line, found ${cmdLines.length}`);
  const cmd = cmdLines[0];

  // Must reference the real worker source or its compiled dist output.
  const referencesWorkerSource =
    /apps\/worker\/src\/index\.(ts|js)/.test(cmd) ||
    /apps\/worker\/dist\/index\.js/.test(cmd) ||
    // pnpm filter form: "pnpm" "--filter" "@gml/worker" "exec" "tsx" "src/index.ts"
    (/@gml\/worker/.test(cmd) && /src\/index\.ts/.test(cmd)) ||
    // package-script form: "pnpm" "--filter" "@gml/worker" "start"
    (/@gml\/worker/.test(cmd) && /\bstart\b/.test(cmd));
  assert.ok(
    referencesWorkerSource,
    `CMD must reference apps/worker/src/index.ts or dist/index.js; got: ${cmd}`,
  );

  // Must invoke one of node / tsx / pnpm.
  const referencesRuntime = /\b(node|tsx|pnpm)\b/.test(cmd);
  assert.ok(
    referencesRuntime,
    `CMD must invoke node, tsx, or pnpm; got: ${cmd}`,
  );
});

test("FR-007: CMD uses JSON-array exec form (not shell form)", () => {
  const df = readText("docker/worker.Dockerfile");
  const cmdLine = df.split(/\r?\n/).find((l) => /^\s*CMD\s/.test(l));
  assert.ok(cmdLine, "worker.Dockerfile must have a CMD instruction");
  // Exec form starts with [ after CMD; shell form would be CMD pnpm … (no bracket).
  assert.match(
    cmdLine,
    /^\s*CMD\s*\[/,
    `CMD must be JSON-array exec form so worker is PID 1 and gets SIGTERM cleanly; got: ${cmdLine}`,
  );
});

test("FR-003: ffmpeg is apt-installed in the worker image", () => {
  const df = readText("docker/worker.Dockerfile");
  assert.match(
    df,
    /ffmpeg/,
    "worker.Dockerfile must install ffmpeg (transcode.ts spawns it from PATH)",
  );
  // Belt-and-braces: ensure it shows up in an apt-get install line, not just a comment.
  assert.match(
    df,
    /apt-get\s+install[^\n]*ffmpeg/,
    "ffmpeg must be installed via apt-get install (not just mentioned in a comment)",
  );
});

test("FR-004: real worker source file exists on disk", () => {
  // The CMD pointer is only useful if the file it points at exists.
  assert.ok(
    existsSync(resolve(root, "apps/worker/src/index.ts")),
    "apps/worker/src/index.ts must exist — this is the file the new CMD invokes",
  );
  assert.ok(
    existsSync(resolve(root, "apps/worker/package.json")),
    "apps/worker/package.json must exist — pnpm --filter @gml/worker needs it",
  );
});

test("FR-006: tsx is declared as a dev dependency of @gml/worker", () => {
  const pkg = JSON.parse(readText("apps/worker/package.json"));
  assert.ok(
    pkg.devDependencies?.tsx,
    "tsx must be in @gml/worker devDependencies so `pnpm exec tsx` resolves in the container",
  );
});
