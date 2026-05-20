import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("auth.ts wires Nodemailer/Email provider", () => {
  const src = read("apps/web/src/auth.ts");
  assert.match(src, /nodemailer|Email/);
});

test("apps/web depends on nodemailer", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(deps["nodemailer"]);
});

test("email-link-form exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/login/email-link-form.tsx")));
});
