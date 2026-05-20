import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("gate/[slug]/page.tsx exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/gate/[slug]/page.tsx")));
});

test("gate/[slug]/actions.ts has verifyGate server action", () => {
  const src = read("apps/web/src/app/gate/[slug]/actions.ts");
  assert.match(src, /verifyGate/);
  assert.match(src, /use server/);
  assert.match(src, /bcrypt/);
  assert.match(src, /rateLimit/);
});

test("middleware also accepts cookie marker for gate", () => {
  const src = read("apps/web/src/middleware.ts");
  assert.match(src, /gml-gate-|cookie/i, "middleware must consult cookie for gate state");
});
