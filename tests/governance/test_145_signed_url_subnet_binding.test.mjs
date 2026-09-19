// Governance test for spec 145 — signed-URL subnet binding.
//
// INVERTED. Spec 145 refined a hand-rolled media-token signer so that it bound
// tokens to a /24 (IPv4) or /64 (IPv6) prefix instead of an exact address. The
// refinement was a genuine improvement on what came before. The signer it
// improved has since been deleted outright, and these tests now pin its
// absence.
//
// WHY THE WHOLE MECHANISM WENT, RATHER THAN GETTING FIXED AGAIN:
//
//   1. IP BINDING WAS BOTH TOO WEAK AND TOO STRONG. Behind carrier-grade NAT --
//      which is how essentially every mobile subscriber in Ladakh reaches the
//      internet -- a /24 is shared by thousands of unrelated people, so it
//      identified nobody. Meanwhile a teacher whose phone hands off between Jio
//      and Airtel mid-lesson changes prefix and gets a hard failure. It was
//      hostile to the real users and useless against the real threat. Spec 145
//      widened /32 to /24 to reduce the false rejections; the direction was
//      right and the destination was "do not bind to IP at all".
//
//   2. THE SECRET WAS A PUBLISHED PLACEHOLDER. `MEDIA_SIGN_SECRET ?? AUTH_SECRET`,
//      and MEDIA_SIGN_SECRET was set nowhere, while the shipped .env carried a
//      literal `dev-only-...` AUTH_SECRET. Every media URL in the product was
//      signed with a value committed to the repository.
//
//   3. THE PAYLOAD PARSER WAS WRONG. It joined fields with ":" and read
//      objectKey back as `fields[1]`, so any key containing a colon decoded to
//      a different object than the one signed.
//
//   4. IT ANSWERED THE WRONG QUESTION. A token proved "this string verifies",
//      never "this person may watch this video". Demote a user and their
//      outstanding tokens kept working to expiry.
//
// The replacement asks the real question instead: /api/media/playlist/[id] is a
// session-authenticated route that calls assertCanAccessVideo on every request,
// and the segment URLs it embeds are minted by Supabase Storage, scoped to one
// object, only after that check has passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const exists = (p) => existsSync(resolve(root, p));

/** Every .ts/.tsx file under the given repo-relative roots. */
function sourceFiles(roots) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(resolve(root, rel)).isDirectory()) { walk(rel); continue; }
      if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** Comments stripped, so a file documenting the removal does not trip the check. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PLAYLIST_ROUTE = "apps/web/src/app/api/media/playlist/[id]/route.ts";
const SPEC_DIR = "specs/145-signed-url-subnet-binding";

test("spec 145 — the hand-rolled signer is gone", () => {
  for (const p of [
    "apps/web/src/lib/video/signed-url.ts",
    "apps/web/src/app/api/media/[token]/route.ts",
  ]) {
    assert.ok(!exists(p), `${p} must not exist — see this file's header for why`);
  }
});

test("spec 145 — nothing mints or verifies a media token any more", () => {
  // A source-wide sweep, because the failure mode being guarded against is a
  // future contributor reintroducing "just a small signed URL helper" beside
  // the real authorization check.
  const offenders = sourceFiles(["apps/web/src", "apps/worker/src", "packages/shared/src"])
    .filter((f) => /(signMediaToken|verifySignedToken|ipToBindKey)/.test(code(read(f))));
  assert.deepEqual(
    offenders,
    [],
    `these files still reference the deleted signer: ${offenders.join(", ")}`,
  );
});

test("spec 145 — MEDIA_SIGN_SECRET is no longer read anywhere", () => {
  const offenders = sourceFiles(["apps/web/src", "apps/worker/src"])
    .filter((f) => /MEDIA_SIGN_SECRET/.test(code(read(f))));
  assert.deepEqual(
    offenders,
    [],
    "MEDIA_SIGN_SECRET must not be read — it was never set, so the signer silently " +
      "fell back to a dev-only AUTH_SECRET committed to the repo",
  );
});

test("spec 145 — playback authorization is re-decided from the session, per request", () => {
  const src = read(PLAYLIST_ROUTE);
  assert.match(
    src,
    /const session = await auth\(\)/,
    "the playlist route must establish the caller from the session, not from a token",
  );
  assert.match(
    src,
    /await assertCanAccessVideo\(actor, id\)/,
    "every playlist request must re-run the ownership check, so revoking access " +
      "revokes playback rather than waiting for a token to expire",
  );
  assert.ok(
    !/x-forwarded-for|x-real-ip/.test(src),
    "the route must not consult the client IP — binding playback to an IP prefix " +
      "broke roaming users and identified nobody behind carrier-grade NAT",
  );
});

test("spec 145 — the playlist response is not cacheable by a shared cache", () => {
  const src = read(PLAYLIST_ROUTE);
  assert.match(
    src,
    /"Cache-Control":\s*"private, no-store/,
    "the body embeds URLs minted for ONE viewer; a shared cache holding it would " +
      "hand another user a working set of segment URLs",
  );
});

test("spec 145 — the spec folder is retained as history", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(exists(`${SPEC_DIR}/${name}`), `${SPEC_DIR}/${name} must remain`);
  }
});
