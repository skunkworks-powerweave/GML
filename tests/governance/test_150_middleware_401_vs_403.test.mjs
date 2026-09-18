// Governance test for spec 150 — Middleware 401-vs-403 distinction
// (Workflow Run 14 audit-closure, MEDIUM severity).
//
// Pre-spec the middleware lines 57-60 were flagged for returning 403
// (rewrite to /forbidden) regardless of whether the user was
// unauthenticated or merely under-privileged. Spec 150 splits the two
// paths explicitly:
//
//   1. No session → 302 redirect to /login?from=<encoded-path>
//      (and ?next=<pathname> preserved as legacy alias).
//   2. Session present + role insufficient → rewrite to /forbidden
//      with EXPLICIT { status: 403 } so non-browser callers see the
//      correct HTTP code.
//
// The test gate pins:
//   - the two branches as separate `if` blocks,
//   - the ordering invariant (session-check first),
//   - the `from` + `next` parameter pair on the redirect,
//   - the explicit `{ status: 403 }` on the rewrite,
//   - the inline Spec-150 marker so the fix is self-documenting,
//   - the spec-kit file presence + plan.md contract shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MW_PATH = "apps/web/src/proxy.ts";
const SPEC_DIR = "specs/150-middleware-401-vs-403";

// ---------- Spec-kit + plan.md contract ----------

test("spec 150 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the middleware-401-vs-403 spec`,
    );
  }
});

test("spec 150 — plan.md follows the CREATED/EDITED/MIGRATED contract and names middleware.ts", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /middleware\.ts/,
    "plan.md must call out the middleware.ts edit in the EDITED line",
  );
});

// ---------- middleware.ts — self-documenting marker ----------

test("spec 150 — middleware.ts carries an inline `Spec 150` reference", () => {
  // The marker lets a future contributor reading the file know to
  // consult the spec before reverting the 401/403 split. Same pattern
  // used by spec 141, 148, 149.
  const src = read(MW_PATH);
  assert.match(
    src,
    /Spec 150/,
    "middleware.ts must carry an inline `Spec 150` reference so the fix is self-documenting",
  );
});

// ---------- middleware.ts — two separate branches, ordering invariant ----------

test("spec 150 — middleware.ts declares two separate auth-failure branches in the correct order", () => {
  const src = read(MW_PATH);
  // The no-session branch must exist as its own `if` block.
  assert.match(
    src,
    /if\s*\(\s*!signedIn\s*\|\|\s*!isRoleName\(role\)\s*\)/,
    "proxy.ts must declare the unauthenticated branch as its own `if`. The test "
      + "was `!session?.user`; it is now `!signedIn || !isRoleName(role)`, which is "
      + "STRICTLY STRONGER: a token that verifies but carries no usable role claim "
      + "(the shape produced when the access-token hook is not registered) is "
      + "treated as signed-out rather than as a user with an unknown role.",
  );
  // The insufficient-role branch must exist as its own `if` block.
  assert.match(
    src,
    /if\s*\(\s*policy\.roles\s*&&\s*!\s*hasAnyRole\(/,
    "middleware.ts must declare `if (policy.roles && !hasAnyRole(...))` as a standalone branch (the 403 path)",
  );
  // The session-check MUST appear in source order BEFORE the role
  // check — otherwise an unauthenticated visit to /admin/* would
  // short-circuit into a 403 rewrite (the audit finding). We measure
  // the position of the GUARD CONDITIONS themselves (the `if (...)`
  // headers), not the `hasAnyRole` import line which precedes both.
  const sessionIdx = src.indexOf("if (!signedIn || !isRoleName(role))");
  // The role-check branch begins with `if (policy.roles && !hasAnyRole`.
  const roleIdx = src.indexOf("if (policy.roles && !hasAnyRole");
  assert.ok(
    sessionIdx > 0 && roleIdx > 0,
    `both branch headers must exist in middleware.ts (got sessionIdx=${sessionIdx}, roleIdx=${roleIdx})`,
  );
  assert.ok(
    sessionIdx < roleIdx,
    `the session-check branch must appear BEFORE the role-check branch in source order (got sessionIdx=${sessionIdx}, roleIdx=${roleIdx}) — otherwise an unauthenticated visit to /admin/* would 403 instead of redirecting to login`,
  );
});

// ---------- middleware.ts — 401-equivalent path: redirect to /login with from+next ----------

test("spec 150 — no-session branch redirects to /login with both `from` and `next` query params", () => {
  const src = read(MW_PATH);
  // The branch must call NextResponse.redirect (not rewrite) — the
  // browser needs to see the URL change so it knows to render the
  // login page, not the protected path with a login body.
  assert.match(
    src,
    /if\s*\(\s*!signedIn[\s\S]{0,600}NextResponse\.redirect\(/,
    "the no-session branch must call NextResponse.redirect (not rewrite)",
  );
  // The redirect URL must include a `from` query param — spec-150's
  // canonical key, aligned with the rest of the LMS audit-export
  // convention.
  assert.match(
    src,
    /searchParams\.set\(\s*"from"\s*,/,
    "the no-session branch must set a `from=` query param on the redirect URL (spec-150 canonical key)",
  );
  // The legacy `next` query param must be preserved so any existing
  // caller reading `next` from the URL still works during the
  // transition.
  assert.match(
    src,
    /searchParams\.set\(\s*"next"\s*,/,
    "the no-session branch must also set a `next=` query param (legacy alias for backward compatibility with pre-spec-150 callers)",
  );
  // The `from` value must include the original search string so a
  // deep link like /admin/users?q=foo survives the login round-trip.
  assert.match(
    src,
    /nextUrl\.search/,
    "the `from` query param must include `nextUrl.search` so query strings on the original request survive the login round-trip",
  );
});

// ---------- middleware.ts — 403 path: rewrite to /forbidden with explicit status ----------

test("spec 150 — insufficient-role branch rewrites to /forbidden with explicit { status: 403 }", () => {
  const src = read(MW_PATH);
  // The branch must call NextResponse.rewrite (NOT redirect — we want
  // the URL bar to stay on the protected path so the user / debugger
  // can see exactly which route was denied).
  assert.match(
    src,
    /if\s*\(\s*policy\.roles\s*&&\s*!hasAnyRole\([\s\S]{0,300}NextResponse\.rewrite\(/,
    "the insufficient-role branch must call NextResponse.rewrite (preserves the URL bar) — NOT redirect",
  );
  // The CRITICAL spec-150 fix: the rewrite call must pass
  // `{ status: 403 }` as the second argument. Without it, the
  // response status defaults to the destination page's status
  // (typically 200 for an RSC page), so curl / fetch callers see
  // 200 OK with a "403 Forbidden" body — the audit finding.
  assert.match(
    src,
    /NextResponse\.rewrite\([^)]+,\s*\{\s*status:\s*403\s*\}/,
    "the insufficient-role branch must pass `{ status: 403 }` as the second argument to NextResponse.rewrite so non-browser callers see the correct HTTP code",
  );
});

// ---------- middleware.ts — the legacy rewrite-without-status shape is GONE ----------

test("spec 150 — the legacy `NextResponse.rewrite(url)` shape (no status override) is no longer present for the forbidden path", () => {
  const src = read(MW_PATH);
  // We can't simply forbid all bare `NextResponse.rewrite(url)` calls
  // because future specs may legitimately add other rewrite branches
  // with their own status semantics. Instead we pin the CONTRACT for
  // the /forbidden rewrite specifically: every rewrite that targets
  // a URL whose pathname is "/forbidden" must carry `{ status: 403 }`.
  // The simplest enforcement is to scan for any `url.pathname = "/forbidden"`
  // immediately preceding a rewrite, and assert the rewrite has the
  // status object.
  const forbiddenAssignIdx = src.indexOf('target.pathname = "/forbidden"');
  assert.ok(
    forbiddenAssignIdx > 0,
    "proxy.ts must still route the role-failure path to /forbidden",
  );
  // From that assignment, the NEXT NextResponse.rewrite call within
  // the next 200 chars must include the status object.
  const tail = src.slice(forbiddenAssignIdx, forbiddenAssignIdx + 400);
  assert.match(
    tail,
    /NextResponse\.rewrite\([^)]+,\s*\{\s*status:\s*403\s*\}/,
    "the rewrite to /forbidden must carry `{ status: 403 }` — the bare `NextResponse.rewrite(url)` shape was the audit finding",
  );
});

// ---------- middleware.ts — matcher config unchanged (no-scope-creep guard) ----------

test("spec 150 — every prefix spec 007 protected is still covered, by POLICIES", () => {
  const src = read(MW_PATH);

  // The matcher used to BE the list of protected prefixes. It no longer is: it
  // is a catch-all, because its first responsibility is persisting a rotated
  // session cookie on every page, not selecting which pages to guard. The
  // policy list took over the guarding, so the no-scope-creep check moved with
  // it. Losing a prefix here would be exactly as bad as losing a matcher entry
  // was, which is why the assertion survives the rewrite.
  for (const prefix of [
    "/dashboard",
    "/admin",
    "/observation",
    "/rtt",
    "/mentorship",
    "/gate",
  ]) {
    assert.ok(
      src.includes(`prefix: "${prefix}"`),
      `POLICIES must still cover "${prefix}" — it was protected before the ` +
        `matcher became a catch-all and must not have been dropped in the move`,
    );
  }
});

// ---------- No-regression / hygiene ----------

test("spec 150 — no new dependencies introduced (NextResponse.rewrite signature already accepts ResponseInit)", () => {
  // The fix uses only the existing `next/server` API. No package
  // additions should have crept into apps/web/package.json as a
  // side-effect of this spec.
  const pkg = read("apps/web/package.json");
  // Sanity: the existing `next` dep is still pinned (we didn't
  // accidentally drop it while editing the workspace).
  assert.match(
    pkg,
    /"next"\s*:/,
    "apps/web must still depend on `next` (the spec fix uses NextResponse, no replacement)",
  );
  // No new HTTP-status helper crept in.
  assert.ok(
    !/http-status-codes/.test(pkg),
    "apps/web must not depend on http-status-codes — the spec-150 fix uses literal `{ status: 403 }`",
  );
});

test("spec 150 — middleware.ts does not contain TODO / FIXME / placeholder markers", () => {
  const src = read(MW_PATH);
  assert.ok(!/\bTODO\b/i.test(src), `${MW_PATH} must not contain TODO markers`);
  assert.ok(!/\bFIXME\b/i.test(src), `${MW_PATH} must not contain FIXME markers`);
  assert.ok(
    !/\bXXX\b/.test(src),
    `${MW_PATH} must not contain XXX placeholder markers`,
  );
});
