import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("middleware.ts exists and uses Auth.js auth() + route matcher", () => {
  const src = read("apps/web/src/proxy.ts");
  assert.match(src, /export\s+default\s+auth\(/, "must export default auth(handler) — Auth.js v5 pattern");
  assert.match(src, /matcher/, "must declare matcher config");
});

test("guards.tsx exports Guarded + requireRole", () => {
  const src = read("apps/web/src/lib/guards.tsx");
  assert.match(src, /requireRole/);
  assert.match(src, /Guarded/);
});

test("shared roles.ts compares roles by exact membership, not by rank", () => {
  const src = read("packages/shared/src/auth/roles.ts");

  // Inverted deliberately. This used to assert that ROLE_RANK was PRESENT --
  // i.e. it pinned the bug in place. The rank map made hasRole a `>=`
  // comparison, so a roles array behaved as a minimum-rank floor: `observer`
  // and `mentor` (both rank 2) satisfied each other, and any list containing
  // `teacher` (rank 1) admitted every authenticated user.
  assert.doesNotMatch(
    src,
    /export\s+const\s+ROLE_RANK/,
    "roles.ts must not export a ROLE_RANK map — role checks are exact, not ranked",
  );
  assert.doesNotMatch(
    src,
    /ROLE_RANK\[[^\]]+\]\s*>=/,
    "roles.ts must not compare roles with >= — that turns an allow-list into a floor",
  );

  assert.match(src, /hasRole/);
  assert.match(src, /hasAnyRole/);
  assert.match(src, /isRoleName/, "roles.ts must export an isRoleName type guard");
  for (const r of ["super_admin", "programme_admin", "mentor", "observer", "teacher"]) {
    assert.match(src, new RegExp(r));
  }
});

test("forbidden page exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/forbidden/page.tsx")));
});

test("dashboard page exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/(authenticated)/dashboard/page.tsx")));
});
