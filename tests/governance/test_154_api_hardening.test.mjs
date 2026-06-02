// Governance test for spec 154 — API hardening (Workflow Run 14
// audit-closure MEDIUM).
//
// Three route handlers under audit:
//
//   1. apps/web/src/app/api/uploads/tus/route.ts (EDITED)
//      — every method handler (GET / POST / HEAD / PATCH / DELETE)
//        now gates on `auth()` via a `requireAuth()` helper and
//        early-returns 401 on missing session;
//      — the 501 response body contains neither the env var name
//        `TUSD_INTERNAL_URL` nor the string `hint`;
//      — the diagnostic is logged via `console.warn` instead.
//
//   2. apps/web/src/app/api/form-drafts/[id]/route.ts (EDITED)
//      — the PUT handler's silent `req.json().catch(() => ({}))`
//        is replaced with an explicit try/catch that returns 400
//        `{ error: "invalid_json", message: String(err) }`.
//
//   3. apps/web/src/app/api/helpdesk/tickets/route.ts (EDITED)
//      — imports `rateLimit` from `@/lib/rate-limit`;
//      — throttles ticket creation at 5 per user per 60 minutes;
//      — on limit-hit returns 429 with `Retry-After` and audits
//        `helpdesk.ticket_rate_limited`;
//      — on Redis fault logs and falls through (fail-open).
//
// Plus the five spec-kit files under specs/154-api-hardening/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const TUS_PATH = "apps/web/src/app/api/uploads/tus/route.ts";
const FORM_DRAFT_PATH = "apps/web/src/app/api/form-drafts/[id]/route.ts";
const HELPDESK_PATH = "apps/web/src/app/api/helpdesk/tickets/route.ts";
const SPEC_DIR = "specs/154-api-hardening";

// ---------- Spec-kit + plan.md contract ----------

test("spec 154 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the api-hardening spec`,
    );
  }
});

test("spec 154 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /uploads\/tus\/route\.ts/,
    "plan.md must call out the tus route edit",
  );
  assert.match(
    src,
    /form-drafts\/\[id\]\/route\.ts/,
    "plan.md must call out the form-drafts route edit",
  );
  assert.match(
    src,
    /helpdesk\/tickets\/route\.ts/,
    "plan.md must call out the helpdesk route edit",
  );
});

// ---------- /api/uploads/tus — auth gate on every handler ----------

test("spec 154 — uploads/tus route imports auth() and declares a requireAuth helper", () => {
  const src = read(TUS_PATH);
  // The `auth` import is the contract that signals every handler can gate
  // on the session. Without this import the whole file falls back to the
  // pre-fix open-to-the-internet posture.
  assert.match(
    src,
    /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/,
    "uploads/tus/route.ts must import { auth } from \"@/auth\"",
  );
  // The helper itself — single point of evolution for the 401 contract.
  // Spec 154 mandates it by name so a refactor can't quietly rename it
  // and miss a handler.
  assert.match(
    src,
    /async\s+function\s+requireAuth\s*\(\s*\)/,
    "uploads/tus/route.ts must declare a requireAuth() helper",
  );
});

test("spec 154 — every uploads/tus method handler gates on requireAuth and returns 401", () => {
  const src = read(TUS_PATH);
  // Each method handler must have a body that calls requireAuth and
  // early-returns 401 when the helper returns null/falsy. We pin the
  // shape `const user = await requireAuth(); if (!user)` so a future
  // contributor adding a new handler has a clear pattern to mirror.
  // The regex tolerates whitespace + a return-value name of `user`.
  for (const method of ["GET", "POST", "HEAD", "PATCH", "DELETE"]) {
    const re = new RegExp(
      `export\\s+async\\s+function\\s+${method}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,400}await\\s+requireAuth\\(\\)`,
    );
    assert.match(
      src,
      re,
      `uploads/tus/route.ts must declare ${method} and call await requireAuth() in the body`,
    );
  }
  // The 401 token itself must appear in the file — the regex above
  // confirms the call site; this assertion confirms the response shape.
  assert.match(
    src,
    /status:\s*401/,
    "uploads/tus/route.ts must return status 401 on missing session",
  );
});

// ---------- /api/uploads/tus — 501 information disclosure ----------

test("spec 154 — uploads/tus 501 response body no longer leaks TUSD_INTERNAL_URL or the hint field", () => {
  const src = read(TUS_PATH);
  // The pre-fix shape returned `{ error: "tusd_not_configured", hint:
  // "Set TUSD_INTERNAL_URL=http://tusd:1080 in .env" }`. The hint leaks
  // both the env var name and the internal hostname/port. We pin its
  // absence as a NextResponse.json body literal.
  // A code-comment can still reference the env var (the diagnostic
  // logged to console mentions it) — we only forbid it inside a
  // NextResponse.json({...}) body, which is the part that reaches the
  // client.
  const lines = src.split(/\r?\n/);
  let insideJsonResponse = false;
  let jsonResponseDepth = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) continue;
    if (/NextResponse\.json\s*\(/.test(line)) {
      insideJsonResponse = true;
      jsonResponseDepth = 0;
    }
    if (insideJsonResponse) {
      jsonResponseDepth += (line.match(/\{/g) || []).length;
      jsonResponseDepth -= (line.match(/\}/g) || []).length;
      assert.ok(
        !/TUSD_INTERNAL_URL/.test(line),
        `uploads/tus/route.ts must not leak the env var name in a NextResponse body — offending line: ${line.trim()}`,
      );
      assert.ok(
        !/"hint"\s*:/.test(line),
        `uploads/tus/route.ts NextResponse body must not contain a "hint" field — offending line: ${line.trim()}`,
      );
      if (jsonResponseDepth <= 0 && /\)/.test(line)) insideJsonResponse = false;
    }
  }
  // The flat token must appear — pinning the response shape.
  assert.match(
    src,
    /"tusd_unavailable"/,
    "uploads/tus/route.ts must return { error: \"tusd_unavailable\" } on the 501 branch",
  );
  // The diagnostic must be logged to the server console so ops can see
  // it without exposing it to the client.
  assert.match(
    src,
    /console\.warn\(/,
    "uploads/tus/route.ts must log the tusd-unavailable diagnostic via console.warn for ops visibility",
  );
});

// ---------- /api/form-drafts/[id] — JSON parse failure ----------

test("spec 154 — form-drafts PUT handler no longer silently swallows malformed JSON", () => {
  const src = read(FORM_DRAFT_PATH);
  // The pre-fix shape was `await req.json().catch(() => ({}))`. The
  // catch swallowed the error and routed an empty object through the
  // Zod schema, which then returned a generic 400. We forbid the literal
  // pattern OUTSIDE comment lines — a code-comment can still reference
  // it as a documentation reference to the pre-fix shape.
  const lines = src.split(/\r?\n/);
  const offending = lines.find((line) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    return /req\.json\(\)\.catch\(\s*\(\)\s*=>\s*\(\{\s*\}\s*\)\s*\)/.test(line);
  });
  assert.equal(
    offending,
    undefined,
    `form-drafts route must not contain \`req.json().catch(() => ({}))\` as live code — spec 154 replaced the silent swallow with an explicit try/catch (offending line: ${offending ?? "<none>"})`,
  );
  // The explicit try/catch must exist — we pin the catch body's response
  // shape (`invalid_json` + `message`) so a refactor can't quietly drop
  // the diagnostic.
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}error:\s*"invalid_json"/,
    "form-drafts route PUT handler must have a catch branch that returns error: \"invalid_json\"",
  );
  assert.match(
    src,
    /error:\s*"invalid_json"[\s\S]{0,200}message:\s*String\(\s*err\s*\)/,
    "form-drafts route PUT handler must forward the parser error via String(err) for client-side diagnostics",
  );
  // The status code is 400 — preserving the existing contract so no
  // client breakage.
  assert.match(
    src,
    /error:\s*"invalid_json"[\s\S]{0,400}status:\s*400/,
    "form-drafts route PUT handler must return status 400 on JSON parse failure",
  );
});

// ---------- /api/helpdesk/tickets — rate limit ----------

test("spec 154 — helpdesk tickets route imports rateLimit from @/lib/rate-limit", () => {
  const src = read(HELPDESK_PATH);
  assert.match(
    src,
    /import\s*\{\s*rateLimit\s*\}\s*from\s*"@\/lib\/rate-limit"/,
    "helpdesk/tickets/route.ts must import { rateLimit } from \"@/lib/rate-limit\"",
  );
});

test("spec 154 — helpdesk tickets route calls rateLimit with the correct bucket / id / limit / window", () => {
  const src = read(HELPDESK_PATH);
  // The call shape — bucket="helpdesk", id=userId (the session.user.id
  // resolved at the top of the handler), limit=5, windowMs=60*60*1000.
  // The regex tolerates whitespace + the limit/window being expressed
  // as inline literals or named constants (we declared HELPDESK_LIMIT
  // and HELPDESK_WINDOW_MS in the implementation).
  assert.match(
    src,
    /rateLimit\(\s*\{[\s\S]{0,400}bucket:\s*"helpdesk"/,
    "helpdesk route must call rateLimit with bucket \"helpdesk\"",
  );
  assert.match(
    src,
    /rateLimit\(\s*\{[\s\S]{0,400}id:\s*userId/,
    "helpdesk route must call rateLimit with id: userId so the throttle is per-user",
  );
  // The limit/window must be either inline literals or the named
  // constants. Both shapes are acceptable — pin the values somewhere
  // in the file so a future tweak shows up.
  assert.ok(
    /HELPDESK_LIMIT\s*=\s*5/.test(src) || /limit:\s*5\b/.test(src),
    "helpdesk route must throttle at 5 tickets (either as HELPDESK_LIMIT = 5 or limit: 5 inline)",
  );
  assert.ok(
    /HELPDESK_WINDOW_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/.test(src) ||
      /windowMs:\s*60\s*\*\s*60\s*\*\s*1000/.test(src),
    "helpdesk route must throttle over a 60-minute window (60 * 60 * 1000 ms)",
  );
});

test("spec 154 — helpdesk tickets route returns 429 with Retry-After on limit hit and audits", () => {
  const src = read(HELPDESK_PATH);
  // 429 status — pinning the response status so a future refactor can't
  // silently swap it for (say) 503.
  assert.match(
    src,
    /status:\s*429/,
    "helpdesk route must return status 429 on rate-limit hit",
  );
  // Retry-After header — clients (and curl users) read this to know
  // when to retry. Pinning it ensures the header survives a refactor.
  assert.match(
    src,
    /"Retry-After":/,
    "helpdesk route must set a Retry-After header on the 429 response",
  );
  // The rate_limited token in the response body so the client can
  // distinguish a throttle from an auth failure.
  assert.match(
    src,
    /"rate_limited"/,
    "helpdesk route 429 body must include the rate_limited error token",
  );
  // The audit row — spec 154 mandates a `helpdesk.ticket_rate_limited`
  // action so abuse patterns are visible in the audit log even when
  // Redis is down (the audit is the deterrent for the fail-open path).
  assert.match(
    src,
    /helpdesk\.ticket_rate_limited/,
    "helpdesk route must record an audit row with action \"helpdesk.ticket_rate_limited\" on throttle hit",
  );
});

test("spec 154 — helpdesk tickets route fails OPEN on Redis fault (logs and falls through)", () => {
  const src = read(HELPDESK_PATH);
  // The fail-open posture is a deliberate design choice (research.md §4).
  // We pin its shape so a future contributor can't quietly switch it to
  // fail-closed without consulting the spec. The shape: try { rateLimit
  // }... catch (err) { console.warn(...) }.
  assert.match(
    src,
    /try\s*\{[\s\S]{0,800}rateLimit\(/,
    "helpdesk route must wrap the rateLimit call in a try block",
  );
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,300}console\.warn\(/,
    "helpdesk route must log via console.warn in the catch branch (fail-open posture)",
  );
  // The catch branch must NOT return — the handler falls through to the
  // ticket-creation path so a Redis outage doesn't block real users.
  // We approximate "no return" by checking the catch body doesn't
  // contain a NextResponse.json call.
  const catchBlockMatch = src.match(/catch\s*\([^)]*\)\s*\{([\s\S]{0,500})\}/);
  if (catchBlockMatch) {
    assert.ok(
      !/NextResponse\.json/.test(catchBlockMatch[1]),
      "helpdesk route rate-limit catch branch must NOT return a NextResponse — the fail-open posture requires falling through to the ticket-creation path",
    );
  }
});

// ---------- No-regression / hygiene ----------

test("spec 154 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [TUS_PATH, FORM_DRAFT_PATH, HELPDESK_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 154 — no new dependencies were introduced", () => {
  // Every fix uses existing helpers (auth, rateLimit, recordAudit). The
  // package.json should be byte-identical to its pre-spec state, so we
  // pin the absence of plausible-but-unwanted additions.
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/express-rate-limit/.test(pkg),
    "apps/web must not depend on express-rate-limit — the fix uses the existing @/lib/rate-limit helper",
  );
  assert.ok(
    !/p-throttle/.test(pkg),
    "apps/web must not depend on p-throttle — the fix uses the existing Redis-backed rateLimit",
  );
});

test("spec 154 — the fix is documented inline so future contributors don't quietly revert it", () => {
  // The inline comments in each touched file reference Spec 154 by
  // number so a future refactor reading the file knows to consult the
  // spec before reverting the gate / the rate limit / the error shape.
  for (const path of [TUS_PATH, FORM_DRAFT_PATH, HELPDESK_PATH]) {
    const src = read(path);
    assert.match(
      src,
      /Spec 154/,
      `${path} must carry an inline \`Spec 154\` reference so the fix is self-documenting`,
    );
  }
});
