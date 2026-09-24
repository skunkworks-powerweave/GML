import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

// The FAB used to open its own sheet of five hardcoded bullets, and these tests
// asserted that sheet. Meanwhile the real HelpPanel -- searchable dictionary,
// helpdesk ticket, WhatsApp / email contacts -- had no entry point on a phone
// at all (its only trigger was the `?` key). The FAB now opens the panel, and
// the sheet's orientation content moved into lib/help.ts, so the "nothing was
// lost" assertions follow it there. Behaviour (a tap dispatches the open event)
// is executed in tests/behaviour/ui-navigation.test.ts.

test("MobileHelpFAB is a client component with the ? glyph", () => {
  const src = read("apps/web/src/components/MobileHelpFAB.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /aria-label="Help"/);
  assert.match(src, /position:\s*"fixed"/);
});

test("MobileHelpFAB opens the shared HelpPanel rather than a private sheet", () => {
  const src = read("apps/web/src/components/MobileHelpFAB.tsx");
  assert.match(src, /import\s*\{\s*openHelp\s*\}\s*from\s*["']@\/components\/help\/HelpPanel["']/);
  assert.match(src, /onClick=\{\(\)\s*=>\s*openHelp\(null\)\}/);
  assert.doesNotMatch(src, /role="dialog"/, "a second, private help dialog would drift from the panel again");
});

test("the orientation the mobile sheet carried is in the help dictionary, in a browse group", () => {
  const src = read("apps/web/src/lib/help.ts");
  assert.match(src, /bottom tabs/i);
  assert.match(src, /WhatsApp/);
  assert.match(src, /confidential/i);
  assert.match(src, /stable wifi/i, "direct browser upload guidance must survive");
  assert.match(src, /sign-in link/i, "the forgotten-password instruction must survive");
  assert.match(src, /id:\s*"start"/, "a Getting started group must list these first");
});

test("the panel the FAB opens is keyboard-dismissable (role=dialog, Close button, Escape)", () => {
  // Carried over from the sheet's own dismiss test: the invariant is about
  // whatever the ? button opens.
  const src = read("apps/web/src/components/help/HelpPanel.tsx");
  assert.match(src, /role="dialog"/);
  assert.match(src, /Close\s*<\/button>/m);
  assert.match(src, /e\.key === "Escape"/);
});

test("MobileShell embeds MobileHelpFAB", () => {
  const src = read("apps/web/src/components/shells/MobileShell.tsx");
  assert.match(src, /MobileHelpFAB/);
});
