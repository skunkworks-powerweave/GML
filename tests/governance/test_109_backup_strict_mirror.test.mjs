// Governance test for spec 109 — backup script strict mirror.
// Asserts scripts/backup.sh no longer silently swallows MinIO mirror
// failures and surfaces them via set -e + ERR trap + explicit success log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const scriptPath = resolve(root, "scripts/backup.sh");

test("FR-109-A: scripts/backup.sh exists", () => {
  assert.ok(existsSync(scriptPath), "scripts/backup.sh must exist");
});

test("FR-109-B: backup.sh has `set -euo pipefail` so non-zero exits abort the script", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert.match(
    src,
    /^set -euo pipefail$/m,
    "scripts/backup.sh must contain `set -euo pipefail` on its own line",
  );
});

test("FR-109-C: backup.sh installs an ERR trap that logs the failing line", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert.match(
    src,
    /trap\s+'[^']*\$LINENO[^']*'\s+ERR/,
    "scripts/backup.sh must `trap '...$LINENO...' ERR` for clear failure logging",
  );
});

test("FR-109-D: backup.sh still runs `mc mirror` (we did not remove the actual mirror step)", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert.match(src, /mc mirror/, "scripts/backup.sh must still invoke `mc mirror`");
});

test("FR-109-E: backup.sh does NOT silence the `mc mirror` step with `|| true`", () => {
  const src = readFileSync(scriptPath, "utf8");
  const lines = src.split(/\r?\n/);
  const offending = lines.filter((ln) => /mc mirror/.test(ln) && /\|\|\s*true/.test(ln));
  assert.equal(
    offending.length,
    0,
    `no line containing \`mc mirror\` may also end with \`|| true\` (found ${offending.length}: ${offending.join(" / ")})`,
  );
});

test("FR-109-F: backup.sh emits a 'MinIO mirror complete' success log so SM-5 drill and cron mail can confirm the mirror really ran", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert.match(
    src,
    /MinIO mirror complete/,
    "scripts/backup.sh must log 'MinIO mirror complete' on the success path",
  );
});

test("FR-109-G: backup.sh measures mirror size with `du -sh` for at-a-glance health monitoring", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert.match(
    src,
    /du -sh/,
    "scripts/backup.sh must use `du -sh` to compute the mirror size for the success log",
  );
});
