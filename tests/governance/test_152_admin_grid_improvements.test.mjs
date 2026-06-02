// Governance test for spec 152 — admin grid improvements.
//
// Workflow Run 14 audit-closure (MEDIUM). Two findings, two contracts, one test
// file:
//
//   (1) admin/data/[entity]/page.tsx — the column filter pushed every column
//       through `ilike(col, "%v%")`. On an enum/boolean/number column Drizzle's
//       pg driver throws (`operator does not exist: integer ~~* unknown`) or
//       silently coerces wrong. Spec 152 introduces a column-type-aware
//       `buildColumnFilter(zodType, col, value)` dispatcher that returns the
//       right Drizzle SQL fragment per Zod type or `null` to skip.
//
//   (2) api/admin/forms/[id]/route.ts — SELECT-then-bump-then-UPDATE race.
//       Spec 152 wraps the pair in `db.transaction(async (tx) => { ... })`
//       and locks the existing row via `.for("update")`. The audit hook
//       fires AFTER the transaction commits (same shape as spec 148).
//
// Asserts (8+):
//   - Both target files still exist at their spec-114 / spec-073 paths.
//   - `page.tsx` imports `z` from "zod" (the dispatcher reads Zod types).
//   - `page.tsx` declares `buildColumnFilter(` as a function the filter loop calls.
//   - `page.tsx` reads `entity.formSchema._def.shape()` (or `.shape` direct) and
//     binds the result so the dispatcher can look up the column's Zod type.
//   - The filter loop in `page.tsx` calls `buildColumnFilter(` and appends to
//     `whereClauses` only when the result is non-null.
//   - The pre-spec blanket `ilike(col as never, "%${value}%")` call inside the
//     loop body is removed — the only remaining `ilike(` call lives inside
//     `buildColumnFilter`'s `ZodString` branch.
//   - `page.tsx` accumulates rejected keys into `skippedFilters` and folds it
//     into the SM-9 PII-audit metadata block.
//   - `route.ts` wraps the SELECT + UPDATE pair in
//     `db.transaction(async (tx) => { ... })`.
//   - The SELECT inside the tx ends in `.for("update")` for row-level locking.
//   - `recordAudit("form.schema.update")` fires AFTER the closing `})` of
//     the transaction callback (commit-then-audit, never the reverse).
//   - All five spec-kit files exist under `specs/152-admin-grid-improvements/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH =
  "apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx";
const ROUTE_PATH = "apps/web/src/app/api/admin/forms/[id]/route.ts";
const SPEC_DIR = "specs/152-admin-grid-improvements";

// Strip block + line comments so a comment that quotes the old shape can't
// satisfy (or invalidate) a code-level pattern match.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");
}

test("spec 152 — both target files still exist at their original paths", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 152 — page.tsx imports z from zod (dispatcher reads Zod type names)", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /import\s+\{\s*z\s*\}\s+from\s+"zod"/,
    "page.tsx must `import { z } from \"zod\"` so buildColumnFilter can type its zodType param",
  );
});

test("spec 152 — page.tsx declares buildColumnFilter(zodType, col, value) helper", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /function\s+buildColumnFilter\s*\(/,
    "page.tsx must declare `function buildColumnFilter(...)` — the column-type dispatcher",
  );
  // The dispatcher must reference every supported Zod type by name.
  for (const t of ["ZodString", "ZodEnum", "ZodBoolean", "ZodNumber"]) {
    assert.match(
      src,
      new RegExp(t),
      `buildColumnFilter must mention ${t} so the dispatch is complete`,
    );
  }
});

test("spec 152 — page.tsx reads entity.formSchema._def.shape() so the dispatcher can look up Zod types per column", () => {
  const src = read(PAGE_PATH);
  // The dispatcher needs the per-column Zod node. Either form is acceptable
  // — the Zod runtime exposes `_def.shape` as either a function or a direct
  // object depending on version.
  assert.match(
    src,
    /entity\.formSchema\._def[\s\S]{0,200}?shape/,
    "page.tsx must read entity.formSchema._def.shape (function or property) to derive per-column Zod types",
  );
});

test("spec 152 — the filter loop calls buildColumnFilter and gates on a non-null return before appending to whereClauses", () => {
  const code = stripComments(read(PAGE_PATH));
  assert.match(
    code,
    /buildColumnFilter\s*\(/,
    "the filter loop must call buildColumnFilter(...)",
  );
  // The loop should null-guard the dispatcher's return before pushing to
  // whereClauses. Look for the shape "clause === null" or "if (clause)".
  assert.match(
    code,
    /(clause\s*===\s*null)|(if\s*\(\s*clause\s*\))/,
    "the filter loop must null-check buildColumnFilter's return before push()",
  );
  assert.match(
    code,
    /whereClauses\.push\(/,
    "the filter loop must still push the resolved SQL fragment into whereClauses",
  );
});

test("spec 152 — the pre-spec blanket-ilike on every column is removed from the filter loop body", () => {
  const code = stripComments(read(PAGE_PATH));
  // The only remaining `ilike(` call should live inside buildColumnFilter's
  // ZodString branch. The shipped pre-spec shape was:
  //   whereClauses.push(ilike(col as never, `%${value}%`));
  // After the dispatcher lands, that exact push-of-ilike pattern must be gone.
  assert.doesNotMatch(
    code,
    /whereClauses\.push\(\s*ilike\(/,
    "the filter loop must not push ilike() directly — it must dispatch through buildColumnFilter",
  );
  // Sanity: ilike is still imported (the dispatcher uses it for ZodString).
  assert.match(
    code,
    /\bilike\b/,
    "ilike must still be imported and referenced (by the dispatcher's ZodString branch)",
  );
});

test("spec 152 — SM-9 audit metadata block includes skippedFilters alongside filters", () => {
  const src = read(PAGE_PATH);
  // The recordAudit metadata block for the *.view action must carry both
  // filters and skippedFilters so the audit row captures user intent even
  // when the dispatcher silently dropped a value.
  assert.match(
    src,
    /skippedFilters/,
    "audit metadata must include skippedFilters so SM-9 captures user intent on rejected filters",
  );
  // The recordAudit call should be the PII-audited (*.view) one.
  assert.match(
    src,
    /action:\s*`\$\{entity\.slug\}\.view`/,
    "the PII audit hook for entity.slug.view must still fire",
  );
});

test("spec 152 — route.ts wraps the SELECT + UPDATE pair in db.transaction(async (tx) => { ... })", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /db\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>/,
    "route.ts must wrap the SELECT + UPDATE pair in db.transaction(async (tx) => { ... })",
  );
});

test("spec 152 — the SELECT inside the tx ends in .for(\"update\") for row-level locking", () => {
  const src = read(ROUTE_PATH);
  // The select chain inside the transaction must include `.for("update")`
  // so concurrent PUTs serialise on the same row. The shape we expect is
  //   tx.select(...).from(feedbackForms).where(...).limit(1).for("update")
  // — we accept any whitespace between operations.
  assert.match(
    src,
    /tx\s*\.\s*select[\s\S]{0,400}?\.\s*for\s*\(\s*["']update["']\s*\)/,
    "the SELECT inside the tx must end with .for(\"update\") to acquire a row-level lock",
  );
});

test("spec 152 — INSIDE the tx the UPDATE goes through tx (not db) on feedbackForms", () => {
  const code = stripComments(read(ROUTE_PATH));
  assert.match(
    code,
    /tx\s*\.\s*update\(\s*feedbackForms\s*\)/,
    "the UPDATE inside the tx must run on tx (not db) so it shares the lock+commit",
  );
  // The original `db.update(feedbackForms)` shape (outside any transaction)
  // must be gone — every write to feedbackForms in this route now goes
  // through the tx connection.
  assert.doesNotMatch(
    code,
    /\bdb\s*\.\s*update\(\s*feedbackForms\s*\)/,
    "the old db.update(feedbackForms) call outside the transaction must be removed",
  );
});

test("spec 152 — recordAudit(form.schema.update) fires AFTER the transaction commits", () => {
  const src = read(ROUTE_PATH);
  const txStart = src.search(/db\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>/);
  assert.ok(txStart >= 0, "db.transaction call must be present");
  const auditIdx = src.search(/recordAudit\(/);
  assert.ok(auditIdx >= 0, "recordAudit call must be present");
  assert.ok(
    auditIdx > txStart,
    "recordAudit must appear AFTER the db.transaction call in source order — audit a commit, not a tentative intent",
  );
  // Stronger: the recordAudit call must NOT be lexically inside the
  // transaction callback. We find the matching `)` for the `db.transaction(`
  // by counting parens.
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
    "recordAudit must appear outside the db.transaction(...) callback body (commit-then-audit, never the reverse)",
  );
  // Audit action + best-effort void discard preserved from the spec-073 shape.
  assert.match(src, /action:\s*"form\.schema\.update"/);
  assert.match(src, /void\s+recordAudit\(/);
});

test("spec 152 — route.ts comment block references spec 152 so the rationale is discoverable from source", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /spec 152|Spec 152|152/,
    "route.ts must reference spec 152 in a comment so a future reader can trace the rationale",
  );
  assert.match(
    src,
    /race|atomic|transaction|FOR UPDATE/i,
    "route.ts comment should explain the race / transaction rationale",
  );
});

test("spec 152 — page.tsx comment block references spec 152", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /spec 152|Spec 152|152/,
    "page.tsx must reference spec 152 in a comment so a future reader can trace the rationale",
  );
});

test("spec 152 — all five spec-kit files exist under specs/152-admin-grid-improvements/", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});
