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
  // This matched `log { output stdout format json }` with no nested braces,
  // which the redacting `format filter { wrap json ... }` below (W3-46) has.
  // The invariant is the same: a log directive, to stdout, encoded as JSON.
  assert.match(site, /^\s*log\s*\{/m, "the site needs a `log` directive -- without one Caddy records no requests");
  const log = block(site, /^\s*log\s*\{/m);
  assert.match(log, /^\s*output\s+stdout\s*$/m, "the access log goes to stdout, where Docker's rotation bounds it");
  assert.match(
    log,
    /\bformat\s+(?:json\b|filter\s*\{\s*wrap\s+json\b)/,
    "the access log is JSON (`format json`, or a `format filter` that wraps json)",
  );
});

// ── W3-46: secrets in query strings ─────────────────────────────────────────
//
// The access line records request>uri: the whole RequestURI, query string
// included. Three routes take a secret there -- the WhatsApp verify token (a
// long-lived shared secret), the PKCE code, and token_hash (a single-use
// recovery / magic-link token that needs nothing from the browser, and stays
// redeemable if the request that carried it failed) -- so a plain
// `format json` wrote each of them into the host's log files, and
// docs/operations.md described the field as "path". The Caddyfile's `filter`
// encoder replaces each one before the line is written.

/** Every query parameter that carries a secret, and the route that reads it. */
const SECRET_QUERY_PARAMS = {
  "hub.verify_token": "apps/web/src/app/api/webhooks/whatsapp/route.ts",
  code: "apps/web/src/app/auth/callback/route.ts",
  token_hash: "apps/web/src/app/auth/confirm/route.ts",
};

/** The `{ ... }` body that follows `opener` in `src`, braces matched. */
function block(src, opener) {
  const at = src.search(opener);
  assert.ok(at >= 0, `no ${opener} block`);
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(src.indexOf("{", at) + 1, i);
  }
  throw new Error(`unbalanced ${opener} block`);
}

/** The `fields { ... }` of a log block's `format filter`, which must stay JSON. */
function filterFields(log, which) {
  assert.match(log, /\bformat\s+filter\s*\{/, `the ${which} must pass through Caddy's \`filter\` encoder to redact anything`);
  const filter = block(log, /\bformat\s+filter\s*\{/);
  assert.match(filter, /\bwrap\s+json\b/, `the filtered ${which} must still be JSON`);
  return block(filter, /\bfields\s*\{/);
}

test("every log line that records a request redacts the secrets the app takes in a query string", () => {
  const caddy = code(read("docker/Caddyfile"));
  // One list of redactions, imported wherever a request's URI is logged.
  const query = block(block(caddy, /^\(query_secrets\)\s*\{/m), /request>uri\s+query\s*\{/);
  for (const [param, route] of Object.entries(SECRET_QUERY_PARAMS)) {
    // The route still takes it from the query string -- if it moves, this
    // list moves with it rather than going stale.
    assert.match(read(route), new RegExp(`searchParams\\.get\\("${param.replace(".", "\\.")}"\\)`), `${route} no longer reads ${param}`);
    assert.match(
      query,
      new RegExp(`^\\s*replace\\s+${param.replace(".", "\\.")}\\s+REDACTED\\s*$`, "m"),
      `${param} (read by ${route}) is written to the logs in clear`,
    );
  }
  // The access log.
  const site = caddy.slice(caddy.indexOf("{$DOMAIN:localhost} {"));
  assert.match(filterFields(block(site, /^\s*log\s*\{/m), "access log"), /^\s*import\s+query_secrets\s*$/m);
  // The default logger, which writes the site's http.log.error lines: a
  // request the proxy could not complete (app restarting) is logged there
  // with its full URI -- and a token_hash in it was never redeemed.
  const globalOptions = block(caddy, /^\{/m);
  assert.match(
    filterFields(block(globalOptions, /^\s*log\s+default\s*\{/m), "default logger"),
    /^\s*import\s+query_secrets\s*$/m,
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
