// docs/audit-actions.md, auth.* and admin.user.* families, checked against the
// recordAudit literals in the code.
//
// ── THE DEFECT (F89) ─────────────────────────────────────────────────────────
//
// The auth section still documented the deleted Auth.js/lockout actions --
// auth.rate_limit.redis_down, auth.account.locked / locked_attempt / unlocked
// (citing an unlock endpoint that no longer exists), the reset token rows --
// and told IT to search for action='login'. None of them can occur. Meanwhile
// the live account-administration trail (admin.user.*) and
// auth.password.changed were not listed at all, so an operator sent to this
// file by docs/operations.md would look for rows that cannot exist and miss the
// offboarding record that does.
//
// A doc drifting from code is exactly what a source-text test CAN check, and
// nothing that executes can: the doc is not code. So the two families are
// compared both ways, literal for literal, and the doc cannot silently drift
// again in either direction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const DOC = readFileSync(resolve(root, "docs/audit-actions.md"), "utf8");
const FAMILIES = [/^auth\./, /^admin\.user\./];

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== ".next") out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every action string passed to recordAudit({ action: ... }) in apps/web/src,
 * and every action the seed scripts INSERT into audit_log themselves.
 *
 * The seed cannot call recordAudit (it lives in apps/web and needs a request
 * scope), so the super_admin bootstrap writes its admin.user.* row with raw
 * SQL (W3-43). This scanned apps/web alone, which counted that documented row
 * as one "the code cannot write".
 */
function codeActions() {
  const found = new Set();
  for (const file of sources(resolve(root, "apps/web/src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/action:\s*([^,}\n]+)/g)) {
      for (const lit of m[1].matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g)) found.add(lit[1]);
    }
  }
  for (const file of sources(resolve(root, "packages/db/src/scripts"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/INSERT INTO audit_log\s*\([^)]*\)\s*VALUES\s*\(([^)]*)\)/g)) {
      for (const lit of m[1].matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)) found.add(lit[1]);
    }
  }
  return [...found].filter((a) => FAMILIES.some((f) => f.test(a)));
}

/** Actions the doc lists as table rows (the first cell of a | `x` | row). */
function docActions() {
  return [...DOC.matchAll(/^\|\s*`([a-z_]+(?:\.[a-z_]+)+)`\s*\|/gm)]
    .map((m) => m[1])
    .filter((a) => FAMILIES.some((f) => f.test(a)));
}

test("every auth.* and admin.user.* action the code records is documented", () => {
  const documented = new Set(docActions());
  const missing = codeActions().filter((a) => !documented.has(a));
  assert.deepEqual(missing, [], "recorded but not in docs/audit-actions.md");
});

test("docs/audit-actions.md lists no auth.* or admin.user.* action the code cannot write", () => {
  const recorded = new Set(codeActions());
  const dead = docActions().filter((a) => !recorded.has(a));
  assert.deepEqual(dead, [], "documented but never recorded (an operator searching for these finds nothing)");
});

test("the doc no longer sends IT looking for Auth.js login/logout rows", () => {
  assert.doesNotMatch(DOC, /action='login'|Auth\.js session events/);
});
