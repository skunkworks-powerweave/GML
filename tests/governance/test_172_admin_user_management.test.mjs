// Governance test for /admin/users.
//
// THE BLOCKER THIS CLOSES. Before this surface existed there was no way to
// create a user at all. The only `insert(users)` in the entire repository was
// the super-admin bootstrap in seed.ts, and README-IT answered the onboarding
// question with a raw `psql UPDATE` on users.role. Teachers -- the whole
// audience of the product -- could not be given accounts by anyone without
// database credentials.
//
// What the assertions below protect is not the existence of the page but the
// four properties that make it safe to hand to a programme administrator:
//
//   1. Privilege cannot be self-granted. A programme_admin who could assign
//      super_admin, or edit their own row, makes the two-tier admin model
//      decorative.
//   2. The organisation cannot be locked out of its own system.
//   3. Deactivation actually ends access, rather than setting a flag that the
//      user's existing token ignores for its full lifetime.
//   4. Passwords never reach the audit log, which every administrator reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const exists = (p) => existsSync(resolve(root, p));

const DIR = "apps/web/src/app/(authenticated)/admin/users";
const ACTIONS = `${DIR}/actions.ts`;
const PAGE = `${DIR}/page.tsx`;
const NAV = "apps/web/src/config/nav.ts";

test("the /admin/users surface exists and is reachable", () => {
  for (const f of ["page.tsx", "actions.ts", "create-user-form.tsx", "user-row.tsx"]) {
    assert.ok(exists(`${DIR}/${f}`), `${DIR}/${f} must exist`);
  }
  const nav = read(NAV);
  assert.match(
    nav,
    /href:\s*"\/admin\/users"/,
    "an admin surface nobody can navigate to is not a surface — it must be in nav.ts",
  );
});

test("the page is role-gated at the page itself", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /requireRole\(\["programme_admin",\s*"super_admin"\]\)/,
    "the guard must be ON the page, not inherited. Layouts and pages render in " +
      "parallel in the App Router, so a page's own queries begin before a " +
      "layout's redirect() resolves",
  );
});

test("every action re-checks the caller — the form is not the control", () => {
  const src = read(ACTIONS);
  const exported = src.match(/export async function (\w+)/g) ?? [];
  assert.ok(exported.length >= 4, "expected create/role/active/password actions");
  for (const decl of exported) {
    const name = decl.replace("export async function ", "");
    const body = src.slice(src.indexOf(decl));
    const fnBody = body.slice(0, body.indexOf("\n}\n") + 3);
    assert.match(
      fnBody,
      /await requireAdmin\(\)/,
      `${name} must call requireAdmin() itself. Server Functions are POSTs to ` +
        `the route that hosts them, so proxy coverage can be removed by a ` +
        `matcher edit — each action carries its own check`,
    );
  }
});

test("programme_admin cannot mint administrators", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /function assignableBy\(actor: RoleName\)/,
    "the assignable-role set must be derived from the CALLER's role",
  );
  assert.match(
    src,
    /actor === "super_admin"\s*\?[\s\S]{0,200}"programme_admin",\s*"super_admin"/,
    "only super_admin may assign the two admin roles — otherwise a " +
      "programme_admin promotes themselves in two clicks",
  );
  // And the check must be applied, not merely defined.
  const applications = src.match(/assignableBy\(actor\.role\)\.includes\(role\)/g) ?? [];
  assert.ok(
    applications.length >= 2,
    "assignableBy must gate BOTH account creation and role changes",
  );
});

test("nobody edits their own row", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /if \(actor\.id === targetId\)/,
    "self-edit must be refused: self-demotion and self-deactivation are the two " +
      "fastest routes to a system nobody can administer, and neither has a " +
      "legitimate use here",
  );
});

test("the last active super admin cannot be removed", () => {
  const src = read(ACTIONS);
  assert.match(src, /function wouldStrandTheOrg\(/, "the guard must exist");
  assert.match(
    src,
    /\.for\("update"\)/,
    "the count must be taken FOR UPDATE — two concurrent deactivations would " +
      "otherwise each observe 'one other remains' and both proceed, leaving " +
      "zero, which is unrecoverable without database access",
  );
  // Applied on both paths that can remove the last one.
  const calls = src.match(/await wouldStrandTheOrg\(tx, targetId\)/g) ?? [];
  assert.ok(
    calls.length >= 2,
    "both demotion and deactivation can strand the organisation; both must check",
  );
});

test("deactivation ends access rather than only setting a flag", () => {
  const src = read(ACTIONS);
  // The profile flag alone leaves the user signed in until their current access
  // token expires, because the hook is only consulted when a token is MINTED.
  //
  // CORRECTED. This used to require `signOut(targetId, "global")` -- which is
  // the defect, not the fix: auth-js's admin signOut takes the target's own
  // JWT, so a user id got 403 bad_jwt from GoTrue on every call, the error came
  // back as a value that nothing checked, and no session ever ended
  // (tests/behaviour/auth-session-revocation.test.ts executes the real path).
  // The invariant is that sessions are ended BY USER ID.
  assert.match(
    src,
    /revokeAllSessions\(targetId\)/,
    "deactivation must end the user's refresh tokens on every device",
  );
  assert.doesNotMatch(
    src,
    /admin\.signOut\(targetId/,
    "auth.admin.signOut() takes a JWT, not a user id: it cannot end another user's sessions",
  );
  assert.match(
    src,
    /ban_duration/,
    "deactivation must also ban the auth user, or they simply sign in again " +
      "with the correct password and get a fresh token",
  );
  assert.match(
    src,
    /ban_duration:\s*"none"/,
    "reactivation must lift the ban, or a reactivated account still cannot sign in",
  );
});

test("a demotion does not wait for the token to expire", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /const isDemotion =/,
    "losing an admin role must end the sessions immediately; a promotion need not",
  );
});

test("passwords never reach the audit log", () => {
  const src = read(ACTIONS);
  for (const block of src.match(/recordAudit\(\{[\s\S]*?\}\)/g) ?? []) {
    assert.ok(
      !/\bpassword\b\s*[,:}]|password:\s*password|plaintext/.test(block),
      `an audit row must not carry a password in any form — the audit log is ` +
        `readable by every administrator:\n${block}`,
    );
  }
  assert.match(
    src,
    /action: "admin\.user\.password_set"/,
    "the FACT of a password change must still be audited",
  );
});

test("a failed profile write does not leave an orphaned auth record", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /deleteUser\(newId\)/,
    "if the profile write fails, the auth record must be removed. Otherwise the " +
      "account can authenticate, is refused a token forever by the hook, and " +
      "has no row in this list to repair it from",
  );
});

test("account creation confirms the email address itself", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /email_confirm:\s*true/,
    "without it GoTrue treats the address as unverified and refuses password " +
      "sign-in — and there is no confirmation email coming, because SMTP is " +
      "deferred to IT",
  );
});
