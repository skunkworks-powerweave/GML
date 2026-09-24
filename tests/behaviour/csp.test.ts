// The Content-Security-Policy the proxy sends, per environment.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// `next dev` could not be used. The production policy was applied in
// development too, and React's development build uses eval() (to rebuild
// server error stacks in the browser) while the dev server's hot reload opens
// a websocket. Both were blocked, so pages rendered but never hydrated: no
// click handler ran, no select changed, and a developer saw a dead page with a
// console full of CSP violations. Next's own CSP guide
// (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md)
// allows 'unsafe-eval' in development for exactly this reason.
//
// The allowance must never reach production, so both sides are pinned here by
// building the real policy under each NODE_ENV.

import { test } from "node:test";
import assert from "node:assert/strict";

const directive = (csp: string, name: string) =>
  csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

async function policyUnder(env: string): Promise<string> {
  const saved = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = env;
  try {
    const { buildCsp } = await import("../../apps/web/src/lib/csp.ts");
    return buildCsp("test-nonce");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = saved;
  }
}

test("production: nonce-only scripts, no eval, no plain websockets", async () => {
  const csp = await policyUnder("production");
  const scripts = directive(csp, "script-src");
  assert.match(scripts, /'nonce-test-nonce'/);
  assert.match(scripts, /'strict-dynamic'/);
  assert.doesNotMatch(scripts, /unsafe-eval|unsafe-inline/, "neither is needed by React or Next in production");
  assert.doesNotMatch(directive(csp, "connect-src"), /(^|\s)ws:/);
});

test("development: React's eval and the hot-reload socket are allowed, so the dev server works", async () => {
  const csp = await policyUnder("development");
  assert.match(directive(csp, "script-src"), /'unsafe-eval'/);
  assert.match(directive(csp, "connect-src"), /(^|\s)ws:/);
  assert.match(directive(csp, "script-src"), /'nonce-test-nonce'/, "the nonce policy itself is unchanged");
});

test("anything that is not exactly 'development' gets the production policy", async () => {
  for (const env of ["test", "staging", ""]) {
    assert.doesNotMatch(directive(await policyUnder(env), "script-src"), /unsafe-eval/, `NODE_ENV=${JSON.stringify(env)}`);
  }
});
