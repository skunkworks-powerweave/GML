import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("proxy.ts refreshes the Supabase session and declares a matcher", () => {
  const src = read("apps/web/src/proxy.ts");

  // Was `export default auth(handler)` — the Auth.js v5 wrapper. Under Supabase
  // this is a plain function, because its FIRST job is not authorization at all:
  // it is the only request path that can persist a rotated refresh-token cookie.
  // Server Components cannot set cookies, so a token refreshed inside a page is
  // computed and then silently discarded.
  assert.match(
    src,
    /export\s+default\s+async\s+function\s+proxy\s*\(/,
    "proxy.ts must export a proxy function (Next 16 renamed the middleware convention)",
  );
  assert.match(
    src,
    /getClaims\(\)/,
    "proxy must call getClaims() — that is what performs the token rotation, and " +
      "it verifies the signature locally against the project JWKS rather than " +
      "making a network round-trip per request",
  );
  assert.match(src, /matcher/, "must declare matcher config");
});

test("proxy.ts carries refreshed cookies onto redirect and rewrite responses", () => {
  const src = read("apps/web/src/proxy.ts");
  assert.match(
    src,
    /function\s+carryCookies\(/,
    "a redirect or rewrite builds a NEW response; without copying the auth " +
      "cookies across, the rotated token is dropped on exactly the requests " +
      "already bouncing a user around the auth boundary",
  );
  for (const branch of ["NextResponse.redirect", "NextResponse.rewrite"]) {
    assert.match(
      src,
      new RegExp(`carryCookies\\(response,\\s*${branch.replace(".", "\\.")}`),
      `${branch} must be wrapped in carryCookies`,
    );
  }
});

test("proxy.ts matcher covers every authenticated segment, not six prefixes", () => {
  const src = read("apps/web/src/proxy.ts");
  // The old matcher listed six prefixes, leaving /videos, /forms, /quizzes,
  // /repo, /settings, /uploads and /inbox to the (authenticated) layout alone.
  // That was merely untidy with an 8h JWT; with a short-lived access token it
  // BREAKS, because those routes would never refresh their cookie.
  assert.match(src, /\(\?\!/, "matcher must be a negative-lookahead catch-all");
  for (const excluded of ["_next/static", "api/webhooks", "api/media", "api/health"]) {
    assert.ok(
      src.includes(excluded),
      `${excluded} must be excluded from the matcher — it is either static bytes, ` +
        `HMAC-authenticated, signed-URL authenticated, or an unauthenticated probe`,
    );
  }
  for (const seg of ["/videos", "/forms", "/quizzes", "/repo", "/settings", "/uploads", "/inbox"]) {
    assert.ok(
      src.includes(`prefix: "${seg}"`),
      `${seg} must appear in POLICIES so an unauthenticated visit redirects ` +
        `rather than rendering a half-page`,
    );
  }
});

test("proxy.ts does not decide section gates from a cookie", () => {
  const src = read("apps/web/src/proxy.ts");
  assert.ok(
    !/gml-gate-/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")),
    "the section gate must not be decided here. It used to compare a " +
      "`gml-gate-<slug>` cookie against the literal string \"1\" — unsigned, not " +
      "bound to a user, never checked against section_gate_grants — so sending " +
      "the header by hand walked in, and rotating a section password revoked " +
      "nobody. Enforcement lives in the gated layouts (assertSectionGate).",
  );
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
