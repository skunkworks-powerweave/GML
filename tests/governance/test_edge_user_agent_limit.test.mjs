// The edge refuses oversized User-Agents before they reach Next.js.
//
// Structural, because it is Caddy configuration: nothing in the Node test tiers
// can execute the Caddyfile. It was verified live on 2026-09-25 with the
// caddy:2.8-alpine image in front of a stub upstream: a 113-character and a
// 999-character User-Agent got 200, a 15,500-character one got 431 in 0.03 s,
// where the same request straight to the app held its event loop for ~2 s
// (Next's HTML_LIMITED_BOT_UA_RE is quadratic on long word runs).
//
// Order matters as much as presence: Caddy runs the FIRST matching `handle`,
// so the refusal must precede the reverse_proxy blocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const caddy = readFileSync(resolve(root, "docker/Caddyfile"), "utf8").replace(/(^|\s)#.*$/gm, "$1");

test("Caddy refuses a User-Agent of 1000+ characters with 431, before any proxying", () => {
  assert.match(caddy, /@oversized_ua\s+header_regexp\s+User-Agent\s+"\^\.\{1000\}"/);
  const refusal = caddy.indexOf("handle @oversized_ua");
  assert.ok(refusal > -1, "the matcher must be used by a handle block");
  assert.match(caddy.slice(refusal, refusal + 120), /respond\s+"[^"]+"\s+431/);
  for (const m of caddy.matchAll(/reverse_proxy\s+app:3000/g)) {
    assert.ok(refusal < m.index, "the refusal must come before every reverse_proxy to the app");
  }
});
