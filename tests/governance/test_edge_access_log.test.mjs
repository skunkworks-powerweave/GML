// Caddy keeps a per-request access log.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Caddy 2 logs HTTP requests only for a site that has a `log` directive, and
// docker/Caddyfile had none; Next.js logs no requests either. So the stack
// kept no record of any request -- no client IP, path, status or latency for a
// sign-in attempt, a media fetch or a webhook call -- while docker-compose.yml
// budgeted for "an access line per request" and docs/operations.md called
// Caddy's access lines the only forensic record. An operator looking into an
// incident would have found nothing.
//
// ── WHAT THIS PINS ───────────────────────────────────────────────────────────
//
// The site block logs as JSON to stdout (where Docker's rotation bounds it),
// credential redaction is left on, and Caddy's rotation holds more than the
// stack default. Text, because no test here can run Caddy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
/** `#`-comment-stripped text, for both the Caddyfile and compose. */
const code = (s) => s.replace(/(^|\s)#.*$/gm, "$1");

test("the site block writes a JSON access log to stdout", () => {
  const caddy = code(read("docker/Caddyfile"));
  const site = caddy.slice(caddy.indexOf("{$DOMAIN:localhost} {"));
  assert.ok(site.length > 0, "the {$DOMAIN:localhost} site block is missing");
  assert.match(
    site,
    /^\s*log\s*\{[^}]*\boutput\s+stdout\b[^}]*\bformat\s+json\b[^}]*\}/m,
    "the site needs `log { output stdout format json }` -- without a log directive Caddy records no requests",
  );
});

test("the access log keeps Caddy's credential redaction on", () => {
  // Caddy redacts Cookie, Set-Cookie, Authorization and Proxy-Authorization in
  // access logs unless `log_credentials` is set. The Supabase session cookies
  // carry the access token, so that switch must never appear.
  assert.doesNotMatch(code(read("docker/Caddyfile")), /\blog_credentials\b/);
});

test("caddy's log rotation holds more than the stack default", () => {
  const yaml = code(read("docker-compose.yml"));
  const start = yaml.indexOf("\n  caddy:\n");
  const block = yaml.slice(start, yaml.indexOf("\nvolumes:", start));
  const size = Number(block.match(/max-size:\s*"(\d+)m"/)?.[1] ?? 0);
  const files = Number(block.match(/max-file:\s*"(\d+)"/)?.[1] ?? 0);
  assert.ok(
    size * files > 30,
    `caddy keeps ${size * files} MB of logs; the access log is the only per-request record, so it gets more than the default 30 MB`,
  );
});
