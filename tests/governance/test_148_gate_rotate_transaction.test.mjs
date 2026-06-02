// Governance test for spec 148 — gate rotation INSERT + DELETE wrapped in db.transaction.
//
// Workflow Run 13 audit-closure (HIGH): the gate-rotation route shipped in spec 115
// with two sequential writes against `db` (INSERT new section_gates row + DELETE old
// section_gate_grants rows). Under the SM-2 substrate-moat threat model — rotation as
// containment for compromised credentials — a <1ms window where the new hash exists
// AND the old grants survive is real attack surface. Spec 148 wraps both writes in a
// single `db.transaction(async (tx) => { ... })` so they commit or roll back atomically.
//
// Asserts (5+):
//   - The route file still exists at the spec-115 path.
//   - The route imports `db` from `@gml/db` (unchanged).
//   - A `db.transaction(async (tx) => { ... })` wrapper is present.
//   - The INSERT inside the transaction uses `tx.insert(sectionGates)` (not `db.insert`).
//   - The DELETE inside the transaction uses `tx.delete(sectionGateGrants)` (not `db.delete`).
//   - The DELETE's `.returning({ id: ... })` is preserved inside the tx callback so
//     the audit's `grantsInvalidated` count still works.
//   - `recordAudit(...)` for `gate.password.rotated` fires AFTER the closing `})` of
//     the transaction callback — auditing the commit, not a tentative intent, and
//     ensuring audit-write failure cannot trigger a rollback.
//   - The audit metadata still references `grantsInvalidated: deleted.length`.
//   - The route comment block carries a spec-148 reference explaining the wrap.
//   - All five spec-kit files exist under `specs/148-gate-rotate-transaction/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts";
const SPEC_DIR = "specs/148-gate-rotate-transaction";

test("spec 148 — rotate route file still exists at the spec-115 path", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 148 — route still imports db from @gml/db (workspace package unchanged)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /import\s+\{[^}]*\bdb\b[^}]*\}\s+from\s+"@gml\/db"/);
});

test("spec 148 — INSERT + DELETE pair is wrapped in db.transaction(async (tx) => { ... })", () => {
  const src = read(ROUTE_PATH);
  // The transaction wrapper must be present with an async (tx) => arrow callback.
  assert.match(
    src,
    /db\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>/,
    "rotate route must wrap the INSERT/DELETE pair in db.transaction(async (tx) => { ... })",
  );
});

test("spec 148 — INSERT inside the transaction uses tx (not db) on sectionGates", () => {
  const src = read(ROUTE_PATH);
  // Strip block comments before pattern-matching so an explanatory comment can't
  // satisfy the assertion on its own.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[^\n]*\/\/.*$/gm, "");
  assert.match(
    code,
    /tx\s*\.\s*insert\(\s*sectionGates\s*\)/,
    "INSERT into sectionGates must run on the tx connection, not db",
  );
  // The original `db.insert(sectionGates)` shape (outside any transaction) must be gone.
  // Allow `db.transaction(...)` itself; the regex below specifically forbids `db.insert(sectionGates)`.
  assert.doesNotMatch(
    code,
    /\bdb\s*\.\s*insert\(\s*sectionGates\s*\)/,
    "the old db.insert(sectionGates) call outside the transaction must be removed",
  );
});

test("spec 148 — DELETE inside the transaction uses tx (not db) on sectionGateGrants", () => {
  const src = read(ROUTE_PATH);
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[^\n]*\/\/.*$/gm, "");
  assert.match(
    code,
    /tx\s*\.\s*delete\(\s*sectionGateGrants\s*\)/,
    "DELETE on sectionGateGrants must run on the tx connection, not db",
  );
  assert.doesNotMatch(
    code,
    /\bdb\s*\.\s*delete\(\s*sectionGateGrants\s*\)/,
    "the old db.delete(sectionGateGrants) call outside the transaction must be removed",
  );
});

test("spec 148 — DELETE preserves .returning({ id: sectionGateGrants.id }) inside the tx", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /tx\s*\.\s*delete\(\s*sectionGateGrants\s*\)[\s\S]{0,400}?\.returning\(\s*\{\s*id:\s*sectionGateGrants\.id\s*\}\s*\)/,
    "the tx.delete(sectionGateGrants) call must keep .returning({ id: sectionGateGrants.id }) so the audit's grantsInvalidated count still works",
  );
});

test("spec 148 — recordAudit(gate.password.rotated) fires AFTER the transaction closes", () => {
  const src = read(ROUTE_PATH);
  const txStart = src.search(/db\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>/);
  assert.ok(txStart >= 0, "db.transaction call must be present");
  const auditIdx = src.search(/recordAudit\(/);
  assert.ok(auditIdx >= 0, "recordAudit call must be present");
  assert.ok(
    auditIdx > txStart,
    "recordAudit must appear AFTER the db.transaction call in source order so we audit a commit, not a tentative intent",
  );
  // Stronger: the recordAudit call should not be lexically inside the transaction
  // callback body. We find the matching `})` for the db.transaction by counting
  // braces from the txStart onward.
  const txOpenParen = src.indexOf("(", txStart + "db.transaction".length);
  assert.ok(txOpenParen >= 0);
  let depth = 1;
  let i = txOpenParen + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
  }
  const txClose = i; // index just after the matching ')'
  assert.ok(
    auditIdx > txClose,
    "recordAudit must appear outside the db.transaction(...) callback body",
  );
});

test("spec 148 — audit metadata still references grantsInvalidated: deleted.length", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /action:\s*"gate\.password\.rotated"/);
  assert.match(src, /grantsInvalidated:\s*deleted\.length/);
  // The recordAudit call must still be best-effort `void`-discarded.
  assert.match(src, /void\s+recordAudit\(/);
});

test("spec 148 — route comment block carries a spec-148 reference explaining the wrap", () => {
  const src = read(ROUTE_PATH);
  // The header should mention spec 148 by number so future readers can trace
  // the rationale back to this spec-kit folder.
  assert.match(
    src,
    /spec 148|Spec 148|148/,
    "route must reference spec 148 in a comment so the rationale is discoverable from source",
  );
  // Mention the threat the wrap closes.
  assert.match(
    src,
    /race|atomic|transaction/i,
    "route comment should explain the race-window / atomicity rationale",
  );
});

test("spec 148 — all five spec-kit files exist under specs/148-gate-rotate-transaction/", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});
