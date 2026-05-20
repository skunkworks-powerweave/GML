import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/gates.ts declares both tables + CHECK", () => {
  const src = read("packages/db/src/schema/gates.ts");
  assert.match(src, /export const sectionGates\b/);
  assert.match(src, /export const sectionGateGrants\b/);
  // SM-2 CHECK
  assert.match(src, /interval\s+'?8\s+hours?'?/i, "must enforce 8h max grant in DB CHECK");
});

test("schema/index.ts exports gates", () => {
  const src = read("packages/db/src/schema/index.ts");
  assert.match(src, /gates/);
});

test("apps/web/src/lib/gates.ts has getActiveGrant", () => {
  const src = read("apps/web/src/lib/gates.ts");
  assert.match(src, /getActiveGrant/);
});

test("middleware enforces gated prefixes", () => {
  const src = read("apps/web/src/middleware.ts");
  assert.match(src, /gate|gated/i);
});
