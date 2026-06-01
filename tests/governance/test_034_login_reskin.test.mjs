import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("login page is a client component with two-pane layout", () => {
  const src = read("apps/web/src/app/login/page.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /gridTemplateColumns:\s*"1\.05fr 1fr"/);
});

test("login page renders mountain SVG (prototype port)", () => {
  const src = read("apps/web/src/app/login/page.tsx");
  // Composite path from prototype
  assert.match(src, /M0 420 L80 320/);
  assert.match(src, /L260 240/);
  assert.match(src, /linearGradient id="login-sky"/);
});

test("login page has Password + Magic link tab switch", () => {
  const src = read("apps/web/src/app/login/page.tsx");
  assert.match(src, /\["password",\s*"magic"\]/);
  assert.match(src, /useState<"password" \| "magic">/);
});

test("login page reuses loginAction + EmailLinkForm", () => {
  const src = read("apps/web/src/app/login/page.tsx");
  assert.match(src, /from "\.\/actions"/);
  assert.match(src, /from "\.\/email-link-form"/);
});

test("login page shows EN/HI/BO language hints", () => {
  const src = read("apps/web/src/app/login/page.tsx");
  assert.match(src, /हिन्दी/);
  assert.match(src, /Ladakhi/);
});

test("brand panel has tagline from prototype", () => {
  const src = read("apps/web/src/app/login/page.tsx");
  assert.match(src, /from Leh to Drass/);
});
