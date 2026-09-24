// Wiring for the audit-export gate fix.
//
// /admin/audit is behind the admin section password (admin/audit/layout.tsx);
// /api/admin/audit/export streamed the same rows -- up to 10k, with ip, user
// agent and metadata -- after a role check alone. The grant lookup itself
// (getActiveGrant -> activeGrant in lib/visibility.ts) is executed against
// Postgres in tests/behaviour/access-control.test.ts ("an admin ROLE is not an
// admin section grant"). A Route Handler cannot be imported by node:test, so
// this file pins that the route consults it, and in the right ORDER, on source
// with comments stripped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const EXPORT = "apps/web/src/app/api/admin/audit/export/route.ts";

test("audit export checks the admin gate grant before it reads a row or records an export", () => {
  const src = code(read(EXPORT));
  const gate = src.search(/getActiveGrant\(\s*session\.user\.id\s*,\s*"admin"\s*\)/);
  assert.ok(gate > 0, "the route must look up the caller's admin section grant");

  const role = src.search(/hasAnyRole\(/);
  const rows = src.search(/\.from\(\s*auditLog\s*\)/);
  const exported = src.search(/action:\s*"audit\.bulk_export"/);
  assert.ok(role > 0 && role < gate, "role check first (403 forbidden), then the gate");
  assert.ok(rows > gate, "no audit row may be selected before the gate check");
  assert.ok(exported > gate, "a denied request must not write an audit.bulk_export row");

  // JSON, not a redirect: assertSectionGate() redirect()s, which in a Route
  // Handler is a 307 to an HTML page where this route promises status codes.
  assert.doesNotMatch(src, /assertSectionGate\(/);
  assert.match(src, /"gate_required"/);
  assert.match(src, /status:\s*403/);
  // The denial leaves a trace of its own.
  assert.match(src, /action:\s*"audit\.bulk_export\.gate_denied"/);
});

test("docs/audit-actions.md documents audit.bulk_export.gate_denied", () => {
  assert.match(read("docs/audit-actions.md"), /`audit\.bulk_export\.gate_denied`/);
});
