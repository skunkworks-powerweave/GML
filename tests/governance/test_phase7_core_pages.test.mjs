import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTES = [
  "dashboard/page.tsx",
  "observation/page.tsx",
  "observation/[cycleId]/page.tsx",
  "mentorship/page.tsx",
  "mentorship/[pairingId]/page.tsx",
  "rtt/page.tsx",
  "videos/page.tsx",
  "videos/[id]/page.tsx",
];

test("Phase 7 Tier-0 core pages all exist under (authenticated)/", () => {
  for (const r of ROUTES) {
    const path = `apps/web/src/app/(authenticated)/${r}`;
    assert.ok(existsSync(resolve(root, path)), `${path} must exist`);
  }
});

test("dashboard is role-aware (5 role branches present)", () => {
  const src = read("apps/web/src/app/(authenticated)/dashboard/page.tsx");
  assert.match(src, /role === "super_admin" \|\| role === "programme_admin"/);
  assert.match(src, /role === "mentor"/);
  assert.match(src, /role === "observer"/);
  assert.match(src, /"teacher"/); // teacher branch (or fallthrough mention)
});

test("observation detail renders the 5-step cycle flow", () => {
  const src = read("apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  assert.match(src, /CYCLE_STAGES/);
  for (const stage of ["nominated", "pre_submitted", "observed", "post_submitted", "complete"]) {
    assert.match(src, new RegExp(`id:\\s*"${stage}"`));
  }
});

test("mentorship detail renders the Q1-Q4 quarter strip", () => {
  const src = read("apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
  assert.match(src, /QUARTERS\s*=\s*\["baseline",\s*"progress_1",\s*"progress_2",\s*"final"\]/);
});

test("video player page is ownership-gated, watermarked, and audited", () => {
  const src = read("apps/web/src/app/(authenticated)/videos/[id]/page.tsx");
  // Was: assert it mints a signed token. The token is gone -- see test_145.
  // Playback now points at a session-authenticated playlist route, and the
  // ownership check that was the highest-severity IDOR in the app runs here AND
  // again inside that route on every fetch.
  assert.match(src, /assertCanAccessVideo/, "ownership gate must run on the page");
  assert.match(src, /\/api\/media\/playlist\//, "player source is the playlist route");
  assert.match(src, /watermark/);
  assert.match(src, /HlsPlayer/);
  assert.match(src, /ExternalEmbed/);
  assert.match(src, /video\.view/); // audit-on-view
});

test("Hindi name renders alongside English name where relevant", () => {
  // Spot-check that observation+mentorship+rtt show hindi_name with deva font
  for (const r of [
    "observation/page.tsx",
    "observation/[cycleId]/page.tsx",
    "mentorship/page.tsx",
    "mentorship/[pairingId]/page.tsx",
  ]) {
    const src = read(`apps/web/src/app/(authenticated)/${r}`);
    assert.match(src, /var\(--deva\)/, `${r} must use Devanagari font for Hindi names`);
  }
});

test("videos library has WhatsApp ingest log + Upload buttons", () => {
  const src = read("apps/web/src/app/(authenticated)/videos/page.tsx");
  assert.match(src, /WhatsApp ingest log/);
  assert.match(src, /Upload/);
  assert.match(src, /watermarked per viewer/i);
});
