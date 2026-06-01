import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("gate page re-skinned with centered card on parchment", () => {
  const src = read("apps/web/src/app/gate/[slug]/page.tsx");
  assert.match(src, /maxWidth:\s*440/);
  assert.match(src, /var\(--paper\)/);
  assert.match(src, /var\(--card-hi\)/);
});

test("gate page has lock badge SVG", () => {
  const src = read("apps/web/src/app/gate/[slug]/page.tsx");
  assert.match(src, /M5 11h14v10H5/); // lock body path
});

test("gate page has slug-specific labels + taglines", () => {
  const src = read("apps/web/src/app/gate/[slug]/page.tsx");
  for (const slug of ["mentorship", "observation", "admin", "tkt", "ttt"]) {
    assert.match(src, new RegExp(`${slug}:\\s*\\{`), `LABELS must include ${slug}`);
  }
});

test("password input uses mono font + letter-spacing for visual dot distinction", () => {
  const src = read("apps/web/src/app/gate/[slug]/page.tsx");
  assert.match(src, /fontFamily:\s*"var\(--mono\)"/);
  assert.match(src, /letterSpacing:\s*"0\.1em"/);
});

test("gate page explains 8h grant + rate-limit", () => {
  const src = read("apps/web/src/app/gate/[slug]/page.tsx");
  assert.match(src, /8 hours/);
  assert.match(src, /5 wrong attempts/);
});

test("gate page reuses verifyGate action (no behavior change)", () => {
  const src = read("apps/web/src/app/gate/[slug]/page.tsx");
  assert.match(src, /verifyGate/);
});
