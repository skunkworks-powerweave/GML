// Redirects the application issues: where they point, and what they refuse.
//
// ── THE DEFECTS ──────────────────────────────────────────────────────────────
//
// 1. Route handlers built redirects from the request's own URL
//    (`new URL(path, req.url)`, `request.nextUrl.origin`). Behind Caddy that is
//    Next's internal bind address, so a magic-link or password-reset callback,
//    "Mark all read" and "Mark reviewed" sent users to
//    https://0.0.0.0:3000/... -- a page that does not exist -- in production.
// 2. Three copies of a `safeNext` guard rejected `//evil` and `/\evil` but not
//    a control character: `from=/%09/evil.example` decodes to "/\t/evil.example",
//    browsers strip the tab, and the user lands on evil.example right after a
//    genuine sign-in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import "./_ui.js";

const lib = () => import("../../apps/web/src/lib/safe-redirect.ts");

test("only same-origin paths survive, whatever the browser would strip or decode", async () => {
  const { safeInternalPath } = await lib();
  const refused = [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    "\t//evil.example",
    " /evil",
    "https://evil.example/",
    "javascript:alert(1)",
    "evil.example",
    "",
    null,
    undefined,
    "/" + "a".repeat(3000),
    // Same-origin to a URL parser, which strips CR/LF -- but the raw value would
    // reach the Location header, where Node refuses it with a 500.
    "/inbox\r\nSet-Cookie: x=1",
    "/inbox\u0000",
  ];
  for (const raw of refused) {
    assert.equal(safeInternalPath(raw), "/dashboard", `must refuse ${JSON.stringify(raw)}`);
  }
  for (const ok of ["/dashboard", "/observation/5b1f?tab=forms#evidence", "/forms/x%2Fy", "/rtt/teach-back?reviewed=1"]) {
    assert.equal(safeInternalPath(ok), ok);
  }
  assert.equal(safeInternalPath("//evil", "/inbox"), "/inbox", "the fallback is the caller's");
});

test("the auth callback redirects to the public origin, not the server's bind address", async () => {
  const saved = process.env.APP_URL;
  process.env.APP_URL = "https://lms.example.test";
  try {
    const { NextRequest } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("next/server") as typeof import("next/server");
    const { GET } = await import("../../apps/web/src/app/auth/callback/route.ts");
    // What the route sees behind Caddy: Next's own listen address.
    const res = await GET(new NextRequest("http://0.0.0.0:3000/auth/callback?next=/observation"));
    const location = res.headers.get("location") ?? "";
    assert.ok(location.startsWith("https://lms.example.test/login?error=link_invalid"), `redirected to ${location}`);
  } finally {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  }
});

test("no route handler builds a redirect from the request's own URL", () => {
  const appDir = new URL("../../apps/web/src/app/", import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "route.ts") {
        const code = readFileSync(p, "utf8").replace(/\/\/.*$/gm, "");
        if (/NextResponse\.redirect\([\s\S]{0,160}?(req|request)\.(url|nextUrl)|nextUrl\.origin/.test(code)) offenders.push(p);
      }
    }
  };
  walk(appDir.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  assert.deepEqual(offenders, [], "behind the proxy the request URL is the container's bind address");
});
