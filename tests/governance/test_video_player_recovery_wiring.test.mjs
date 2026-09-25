// F08 -- the player's error handling is the executed recovery module.
//
// tests/behaviour/hls-playback-recovery.test.ts runs lib/video/playback-recovery
// (the bounded, status-aware recovery that replaced an endless re-sign loop)
// with a fake <video> and a fake hls.js. What it cannot run is HlsPlayer's
// useEffect, which is what hands a real element to that module: there is no
// DOM in this repo's test tiers. This pins that hand-off, so the component
// cannot drift back to an inline handler the behaviour tests never see.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = stripComments(readFileSync(resolve(root, "apps/web/src/components/video/HlsPlayer.tsx"), "utf8"));

test("F08 — both player branches hand the element to the recovery module", () => {
  assert.match(src, /from\s+"@\/lib\/video\/playback-recovery"/);
  assert.match(src, /attachNative\(\s*video\s*,\s*hooks\s*\)/, "the native branch (Safari, iOS, desktop Chrome)");
  assert.match(src, /attachHls\(\s*video\s*,/, "the hls.js branch");
});

test("F08 — the recovery budget outlives the effect re-run a new source causes", () => {
  assert.match(src, /useRef<PlaybackRecovery>\(\s*createPlaybackRecovery\(\)\s*\)/);
  assert.match(src, /policy:\s*recoveryRef\.current/);
});

test("F08 — no inline error handler re-signs on its own", () => {
  assert.doesNotMatch(src, /addEventListener\(\s*"error"/, "the native error handler lives in the recovery module");
  assert.doesNotMatch(src, /\.on\(\s*Hls\.Events\.ERROR/, "the hls.js error handler lives in the recovery module");
});
