// Substrate-moat gates (SM-1..SM-6). Each future spec is checked against these.
// SM-3 (video originals) lands in spec 027; SM-6 page-by-page lands in spec 070.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|mjs|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src) {
  // Remove /* … */ block comments and // … line comments so the SM-1 grep
  // can't false-positive on cautionary docstrings.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

test("SM-1: no db.update(auditLog) or db.delete(auditLog) in real code (comments stripped)", () => {
  const offenders = [];
  const sources = [
    ...walk(resolve(root, "apps/web/src")),
    ...walk(resolve(root, "packages/db/src")),
    ...walk(resolve(root, "packages/shared/src")),
  ];
  for (const file of sources) {
    const src = stripComments(readFileSync(file, "utf8"));
    if (/db\.update\s*\(\s*auditLog\b/.test(src)) offenders.push(`${file} — db.update(auditLog)`);
    if (/db\.delete\s*\(\s*auditLog\b/.test(src)) offenders.push(`${file} — db.delete(auditLog)`);
    if (/\.update\s*\(\s*auditLog\b/.test(src) && !file.endsWith(".test.mjs"))
      offenders.push(`${file} — .update(auditLog)`);
  }
  assert.equal(offenders.length, 0, `SM-1 violations:\n${offenders.join("\n")}`);
});

test("SM-1 DB-layer revoke SQL is shipped", () => {
  const sqlPath = resolve(root, "packages/db/src/migrations/_post/001_revoke_audit_writes.sql");
  assert.ok(existsSync(sqlPath), "_post revoke SQL must exist");
  const sql = readFileSync(sqlPath, "utf8");
  assert.match(sql, /REVOKE\s+(UPDATE|DELETE)/i);
  assert.match(sql, /audit_log/);
});

test("SM-2: gates schema enforces 8h CHECK", () => {
  const src = read("packages/db/src/schema/gates.ts");
  assert.match(src, /check\s*\(/);
  assert.match(src, /interval\s+'?8\s+hours?'?/i);
});

test("SM-4: README-IT contains the deterrence-not-prevention sentence", () => {
  const md = read("README-IT.md");
  assert.match(md, /deterrence,?\s+not\s+prevention/i);
});

test("SM-5: restore-drill check script exists", () => {
  assert.ok(existsSync(resolve(root, "scripts/check-restore-drill.mjs")));
});

test("docs/substrate-moats.md lists all 6 moats with their enforcement layers", () => {
  const md = read("docs/substrate-moats.md");
  for (const sm of ["SM-1", "SM-2", "SM-3", "SM-4", "SM-5", "SM-6"]) {
    assert.match(md, new RegExp(sm));
  }
  assert.match(md, /append-only|REVOKE/i);
});
