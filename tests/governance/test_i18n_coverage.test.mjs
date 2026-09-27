// No interface text is written into the source.
//
// Every string a person reads comes from the translation bundles, so a user
// who picks Hindi or Bhoti sees it in their language. Before 2026-09 only the
// chrome did, and picking Hindi changed the menu over English pages. This runs
// scripts/i18n-scan.mjs over apps/web/src; text that must stay English on
// purpose carries an i18n-ignore comment with its reason, where a reviewer
// can see it. The scanner's own rules are tested in
// tests/scripts/i18n-scan.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

test("no interface text is written into the source (scripts/i18n-scan.mjs)", () => {
  const r = spawnSync(process.execPath, ["scripts/i18n-scan.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `untranslated strings:\n${r.stdout.split("\n").slice(-60).join("\n")}${r.stderr}`);
});
