// Wiring for the client-ip fix. The BEHAVIOUR -- a spoofed X-Forwarded-For does
// not become the client ip, cannot mint fresh rate-limit keys, and only an IP
// literal that fits varchar(64) is ever returned -- is executed in
// tests/behaviour/request-ip.test.ts. That file cannot prove every caller USES
// the helper; this one does, on source with comments stripped.
//
// The defect was four private copies of
//   hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdr.get("x-real-ip") ?? "unknown"
// each trusting the element the CLIENT writes. A fifth copy anywhere would
// reintroduce it, so the check is repo-wide rather than per-file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

// Block comments, then line comments not preceded by ':' or a quote (so URLs
// such as "https://..." and "//" inside string literals survive).
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const REQUEST_IP = "apps/web/src/lib/request-ip.ts";

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      yield* sourceFiles(p);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
      yield p;
    }
  }
}

test("only lib/request-ip.ts reads X-Forwarded-For / X-Real-IP", () => {
  const offenders = [];
  for (const abs of sourceFiles(resolve(root, "apps/web/src"))) {
    const rel = relative(root, abs).split(sep).join("/");
    if (rel === REQUEST_IP) continue;
    if (/x-forwarded-for|x-real-ip/i.test(code(readFileSync(abs, "utf8")))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "each private copy of the header read trusted the client-supplied first X-Forwarded-For element",
  );
});

test("the gate limiter, the login throttle and the audit log all take the ip from lib/request-ip", () => {
  for (const file of [
    "apps/web/src/app/gate/[slug]/actions.ts",
    "apps/web/src/app/login/email-actions.ts",
    "apps/web/src/lib/audit.ts",
  ]) {
    assert.match(code(read(file)), /from\s+"@\/lib\/request-ip"/, `${file} must import lib/request-ip`);
  }
});
