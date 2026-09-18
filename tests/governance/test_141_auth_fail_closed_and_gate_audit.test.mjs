// Governance test for spec 141 — auth fail-closed + gate audit emission.
//
// Workflow Run 13 audit-closure HIGH severity bundle. Covers:
//   - recordAudit signature change (Promise<void> → Promise<boolean>) so
//     security-critical callers can detect a degraded audit channel.
//   - auth.ts: Redis-down on the rate-limit path now fails CLOSED (return
//     null) AND emits a SEVERE auth.rate_limit.redis_down audit row. The
//     previous silent fail-open catch is gone.
//   - gate/[slug]/actions.ts: every verifyGate path now audits.
//     `gate.attempt.success` on success, `gate.attempt.fail` on both the
//     rate-limit-exceeded and wrong-password paths, and a SEVERE
//     `gate.rate_limit.redis_down` row on the Redis fault path. The
//     Redis-down branch fails CLOSED with a generic outage string.
//   - No metadata block in either file leaks the plaintext password.
//   - docs/audit-actions.md documents both new actions.
//   - All five spec-kit files exist under specs/141-…/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const AUDIT_PATH = "apps/web/src/lib/audit.ts";
const AUTH_PATH = "apps/web/src/auth.ts";
const GATE_PATH = "apps/web/src/app/gate/[slug]/actions.ts";
const DOCS_PATH = "docs/audit-actions.md";

// Comment stripper used by greps that must not be fooled by an explanatory
// comment that names a forbidden token.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[^\n]*\/\/.*$/gm, "");

test("spec 141 — recordAudit returns Promise<boolean> instead of Promise<void>", () => {
  const src = read(AUDIT_PATH);
  // Signature
  assert.match(
    src,
    /export async function recordAudit\(\s*input:\s*AuditInput\s*\)\s*:\s*Promise<boolean>/,
    "recordAudit must declare a Promise<boolean> return type",
  );
  // Both terminals exist
  assert.match(src, /return true;/, "happy path must return true");
  assert.match(src, /return false;/, "failure path must return false");
  // The console.error fallback is still in place — best-effort logging
  // remains the contract; the boolean is the *additional* signal.
  assert.match(src, /console\.error\(\s*"\[audit\] failed to insert"/);
});

test("spec 141 — recordAudit accepts optional userId + ipOverride overrides", () => {
  const src = read(AUDIT_PATH);
  // Type declaration
  assert.match(src, /userId\?:\s*string/);
  assert.match(src, /ipOverride\?:\s*string/);
  // Usage in the body — the override is honoured before falling back to
  // request scope.
  assert.match(src, /input\.userId/);
  assert.match(src, /input\.ipOverride/);
});

test("spec 141 — auth.ts no longer hand-rolls sign-in throttling", () => {
  const src = read(AUTH_PATH);

  // Spec 141's concern was that a Redis fault on the LOGIN path must fail
  // closed. That path is gone: Supabase Auth throttles sign-in centrally, so
  // there is no local limiter on the credential check to fail open OR closed,
  // and no bespoke audit row for its outage.
  //
  // This matters beyond tidiness. The old limiter could not fail closed as
  // designed: getRedis() set maxRetriesPerRequest: null with no commandTimeout
  // and the default offline queue, so with Redis down the command QUEUED
  // FOREVER, rateLimit() never resolved, the documented fail-closed catch was
  // unreachable, and every login request hung.
  const code = stripComments(src);
  assert.ok(
    !/rateLimit\(/.test(code),
    "auth.ts must not call the local rate limiter — sign-in throttling is " +
      "Supabase's, and the local limiter's own failure mode was an indefinite hang",
  );
  assert.ok(
    !/recordAudit\(/.test(code),
    "auth.ts must not write audit rows — it is now a pure session reader with " +
      "no side effects, called on every render",
  );
});

test("spec 141 — sign-in failures are indistinguishable to the caller", () => {
  const src = read(AUTH_PATH);
  // No account-existence oracle. Whether the address is unknown or the password
  // is wrong, the caller gets one string. The single exception is the
  // hook-refused case, which is safe: reaching it requires already holding the
  // correct password.
  assert.match(
    src,
    /return \{ error: "Incorrect email or password\." \};/,
    "the generic credential failure must be a single shared string",
  );
});

test("spec 141 — the remaining rateLimit callers still fail CLOSED", () => {
  // The property spec 141 established is preserved where a local limiter is
  // still the control: the section gate, and the outbound-email actions.
  for (const [path, label] of [
    [GATE_PATH, "gate verification"],
    ["apps/web/src/app/login/email-actions.ts", "email send"],
  ]) {
    const src = read(path);
    assert.match(src, /rateLimit\(/, `${label} must be rate limited`);
    assert.match(
      src,
      /catch[\s\S]{0,400}?(return false|SERVICE_UNAVAILABLE|ok:\s*false)/,
      `${label} must deny on limiter failure, not allow — an attacker who can ` +
        `partition the limiter would otherwise unlock unbounded attempts`,
    );
  }
});

test("spec 141 — gate actions.ts imports recordAudit and declares SERVICE_UNAVAILABLE", () => {
  const src = read(GATE_PATH);
  assert.match(src, /import\s*\{\s*recordAudit\s*\}\s*from\s*"@\/lib\/audit"/);
  // The generic outage copy lives in one named constant so it can't
  // accidentally diverge from the auth-side string.
  assert.match(src, /SERVICE_UNAVAILABLE\s*=\s*"Service temporarily unavailable\."/);
});

test("spec 141 — verifyGate emits gate.attempt.success on the success path", () => {
  const src = read(GATE_PATH);
  assert.match(src, /action:\s*"gate\.attempt\.success"/);
  assert.match(src, /entityType:\s*"section_gate"/);
  // Metadata schema for the success row.
  const successMatch = src.match(
    /action:\s*"gate\.attempt\.success"[\s\S]*?metadata:\s*\{([\s\S]*?)\}/,
  );
  assert.ok(successMatch, "success-path metadata block must exist");
  assert.match(successMatch[1], /slug/);
  assert.match(successMatch[1], /attemptCount/);
  assert.match(successMatch[1], /rateLimited/);
});

test("spec 141 — verifyGate emits gate.attempt.fail on the wrong-password path with reason", () => {
  const src = read(GATE_PATH);
  // Both fail audits are gate.attempt.fail; we need to assert wrong_password
  // is one of the reasons emitted.
  assert.match(src, /action:\s*"gate\.attempt\.fail"/);
  assert.match(src, /reason:\s*"wrong_password"/);
  assert.match(src, /reason:\s*"rate_limit_exceeded"/);
});

test("spec 141 — verifyGate rate-limit Redis-down branch FAILS CLOSED and audits", () => {
  const src = read(GATE_PATH);
  // SEVERE audit row tagged with the documented action name.
  assert.match(src, /action:\s*"gate\.rate_limit\.redis_down"/);
  // Severity tag for ops alerting.
  const severeBlock = src.match(
    /action:\s*"gate\.rate_limit\.redis_down"[\s\S]*?metadata:\s*\{([\s\S]*?)\}/,
  );
  assert.ok(severeBlock, "redis-down metadata block must exist");
  assert.match(severeBlock[1], /severity:\s*"SEVERE"/);
  // Generic outage response — no leak of the failure mode to the user.
  assert.match(src, /error:\s*SERVICE_UNAVAILABLE/);
  // The old fail-open rationale comment is gone.
  const code = stripComments(src);
  assert.doesNotMatch(
    code,
    /fail open/i,
    "the fail-open rationale comment must be replaced",
  );
});

test("spec 141 — gate actions.ts never includes plaintext password in audit metadata", () => {
  const src = read(GATE_PATH);
  const metadataBlocks = src.match(/metadata:\s*\{[\s\S]*?\}/g) ?? [];
  assert.ok(metadataBlocks.length >= 3, "expected at least 3 metadata blocks (success, fail, redis_down)");
  for (const block of metadataBlocks) {
    assert.doesNotMatch(
      block,
      /\bpassword\b/,
      `gate metadata must not contain a plaintext password reference: ${block}`,
    );
    assert.doesNotMatch(
      block,
      /\bplaintext\b/,
      `gate metadata must not contain a plaintext field: ${block}`,
    );
    assert.doesNotMatch(
      block,
      /passwordHash/,
      `gate metadata must not include the password hash: ${block}`,
    );
  }
});

test("spec 141 — docs/audit-actions.md lists both new actions with spec 141 cross-ref", () => {
  const src = read(DOCS_PATH);
  assert.match(src, /gate\.rate_limit\.redis_down/);
  assert.match(src, /auth\.rate_limit\.redis_down/);
  assert.match(src, /141/);
});

test("spec 141 — all five spec-kit files exist under specs/141-auth-fail-closed-and-gate-audit/", () => {
  const SPEC_DIR = "specs/141-auth-fail-closed-and-gate-audit";
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});
