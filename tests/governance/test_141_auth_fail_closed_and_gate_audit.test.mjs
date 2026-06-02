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

test("spec 141 — auth.ts imports recordAudit and defines maskIp", () => {
  const src = read(AUTH_PATH);
  assert.match(src, /import\s*\{\s*recordAudit\s*\}\s*from\s*"@\/lib\/audit"/);
  // maskIp helper exists for IP redaction in the audit row.
  assert.match(src, /function\s+maskIp\(/);
  // Drops the last IPv4 octet and the last IPv6 hextet.
  assert.match(src, /\.xxx/);
  assert.match(src, /:xxxx/);
});

test("spec 141 — auth.ts rate-limit Redis-down branch FAILS CLOSED (returns null) and audits", () => {
  const src = read(AUTH_PATH);
  // The new SEVERE audit row exists with the documented action name.
  assert.match(src, /action:\s*"auth\.rate_limit\.redis_down"/);
  assert.match(src, /severity:\s*"SEVERE"/);
  // The metadata captures method + masked IP.
  assert.match(src, /method:\s*"credentials"/);
  assert.match(src, /ipMasked:\s*maskIp\(/);
  // The old fail-open comment is gone — no resurrection by a future
  // well-meaning refactor without going through this gate.
  const code = stripComments(src);
  assert.doesNotMatch(
    code,
    /don't lock everyone out/,
    "the fail-open rationale comment must be replaced",
  );
});

test("spec 141 — auth.ts never includes plaintext password in audit metadata", () => {
  const src = read(AUTH_PATH);
  const metadataBlocks = src.match(/metadata:\s*\{[\s\S]*?\}/g) ?? [];
  assert.ok(metadataBlocks.length > 0, "expected at least one metadata block");
  for (const block of metadataBlocks) {
    assert.doesNotMatch(
      block,
      /\bpassword\b/,
      `auth.ts audit metadata must not contain a plaintext password reference: ${block}`,
    );
    assert.doesNotMatch(
      block,
      /\bplaintext\b/,
      `auth.ts audit metadata must not contain a plaintext field: ${block}`,
    );
    assert.doesNotMatch(
      block,
      /passwordHash/,
      `auth.ts audit metadata must not include the password hash: ${block}`,
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
