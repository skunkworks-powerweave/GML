import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("MobileHelpFAB is a client component with the ? glyph", () => {
  const src = read("apps/web/src/components/MobileHelpFAB.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /aria-label="Help"/);
  assert.match(src, /position:\s*"fixed"/);
});

test("MobileHelpFAB sheet has orientation bullets", () => {
  const src = read("apps/web/src/components/MobileHelpFAB.tsx");
  assert.match(src, /bottom tabs/i);
  assert.match(src, /WhatsApp/);
  assert.match(src, /confidential/i);
});

test("MobileShell embeds MobileHelpFAB", () => {
  const src = read("apps/web/src/components/shells/MobileShell.tsx");
  assert.match(src, /MobileHelpFAB/);
});

test("MobileHelpFAB sheet is keyboard-dismissable (Close button + role=dialog)", () => {
  const src = read("apps/web/src/components/MobileHelpFAB.tsx");
  assert.match(src, /role="dialog"/);
  // The Close button's label may be on its own line under JSX formatting.
  assert.match(src, /Close\s*<\/button>/m, "must have <button>…Close</button> as the dismiss action");
});
