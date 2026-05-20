// Spec 003 governance test — proves the trivial endpoint + shared contract land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("FR-002: /api/ping route file exists and exports async GET", () => {
  const src = read("apps/web/src/app/api/ping/route.ts");
  assert.match(src, /export\s+async\s+function\s+GET/);
});

test("FR-003: shared zod contract for /api/ping exists", () => {
  const src = read("packages/shared/src/api-contracts/ping.ts");
  assert.match(src, /z\.object/, "must use zod object schema");
  assert.match(src, /pong/, "must include pong key");
});

test("@gml/shared exposes the ping contract via exports map", () => {
  const pkg = JSON.parse(read("packages/shared/package.json"));
  assert.ok(pkg.exports, "package.json must declare exports");
  const ks = Object.keys(pkg.exports);
  const exposed = ks.some((k) =>
    k.includes("api-contracts/ping") || k === "./api-contracts/*" || k === "./*"
  );
  assert.ok(exposed, `must expose ping contract; got keys: ${ks.join(", ")}`);
});

test("@gml/web depends on @gml/shared", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(deps["@gml/shared"], "@gml/web must depend on @gml/shared");
});
