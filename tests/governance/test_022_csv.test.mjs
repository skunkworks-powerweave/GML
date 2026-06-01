import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("CSV helpers exist with exportCsv + importCsv", () => {
  const src = read("apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  assert.match(src, /export async function exportCsv/);
  assert.match(src, /export async function importCsv/);
  assert.match(src, /from "papaparse"/);
});

test("CSV export route returns text/csv", () => {
  const src = read("apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  assert.match(src, /exportCsv/);
});

test("CSV import route consumes CSV body", () => {
  const src = read("apps/web/src/app/api/admin/data/[entity]/import/route.ts");
  assert.match(src, /importCsv/);
  assert.match(src, /req\.text\(\)/);
});

test("admin grid has Export CSV link", () => {
  const src = read("apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");
  assert.match(src, /Export CSV/);
  assert.match(src, /\/api\/admin\/data\/\$\{slug\}\/export/);
});

test("learners CSV export requires super_admin (SM-9)", () => {
  const src = read("apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  assert.match(src, /piiAudited.*learners[\s\S]{0,200}requireRole\(\["super_admin"\]\)/);
});

test("bulk import/export actions follow dotted notation", () => {
  const src = read("apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  assert.match(src, /\$\{entity\.slug\}\.bulk_export/);
  assert.match(src, /\$\{entity\.slug\}\.bulk_import/);
});

test("papaparse + @types/papaparse + zod are declared in apps/web/package.json", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  assert.ok(pkg.dependencies.papaparse, "papaparse required");
  assert.ok(pkg.devDependencies["@types/papaparse"], "@types/papaparse required");
  assert.ok(pkg.dependencies.zod, "zod required");
});
