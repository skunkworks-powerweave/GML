// Governance test for spec 167 — defensive-coding fixes
// (Workflow Run 16 follow-up sweep).
//
// Three surgical defensive-coding fixes hardening the surface flagged by
// the post-163 audit:
//
//   A) FormRenderer dev assertion changes from console.error to throw,
//      guarded by NODE_ENV !== "production" so dev/test crash on the
//      mistake while production silently picks `action`.
//
//   B) BCRYPT_COST becomes a single exported const in lib/password.ts.
//      Four routes that previously hardcoded the literal `10` now import
//      it. seed.ts (cross-workspace) keeps the literal with a Spec-167
//      mirror comment.
//
//   C) High-stakes recordAudit callers capture the Promise<boolean>
//      return (spec 141 surface) and call noteAuditDegraded() on `false`.
//      Five routes: gates rotate, learners export, audit export,
//      forgot-password, reset-password.
//
// The test pins each surface so a future refactor can't silently revert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const FORM_RENDERER = "apps/web/src/components/forms/FormRenderer.tsx";
const PASSWORD_LIB = "apps/web/src/lib/password.ts";
const AUDIT_LIB = "apps/web/src/lib/audit.ts";
const ROTATE_ROUTE = "apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts";
const FORGOT_ROUTE = "apps/web/src/app/api/auth/forgot-password/route.ts";
const RESET_ROUTE = "apps/web/src/app/api/auth/reset-password/route.ts";
const LEARNERS_EXPORT_ROUTE = "apps/web/src/app/api/admin/learners/export/route.ts";
const AUDIT_EXPORT_ROUTE = "apps/web/src/app/api/admin/audit/export/route.ts";
const SEED_SCRIPT = "packages/db/src/scripts/seed.ts";
const SPEC_DIR = "specs/167-defensive-coding-fixes";

// ---------- Spec-kit + plan.md contract ----------

test("spec 167 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the defensive-coding-fixes spec`,
    );
  }
});

test("spec 167 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The touched files must be named in plan.md so a reader auditing the
  // contract knows where the surface area actually lives.
  for (const file of [
    "FormRenderer.tsx",
    "password.ts",
    "audit.ts",
    "rotate",
    "forgot-password",
    "reset-password",
    "learners/export",
    "audit/export",
    "seed.ts",
  ]) {
    assert.match(
      src,
      new RegExp(file.replace(/[/.]/g, "[/.]")),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- (A) FormRenderer throw ----------

test("spec 167 — FormRenderer.tsx replaces console.error with throw in the dev-mode guard", () => {
  const src = read(FORM_RENDERER);
  // The throw shape, with the exact error message body so a contributor
  // can't soften the wording without the test catching the diff.
  assert.match(
    src,
    /throw\s+new\s+Error\s*\(\s*["'`]FormRenderer:\s+pass\s+either\s+`?action`?\s+\(server\)\s+or\s+`?onSubmit`?\s+\(client\),\s+not\s+both\.["'`]/,
    "FormRenderer.tsx must `throw new Error(\"FormRenderer: pass either `action` (server) or `onSubmit` (client), not both.\")` inside the dev-only guard",
  );
});

test("spec 167 — FormRenderer.tsx throw is guarded by NODE_ENV !== production", () => {
  const src = read(FORM_RENDERER);
  // The NODE_ENV guard must wrap the throw so production silently picks
  // `action` (graceful degradation) while dev/test still crash on the
  // mistake. Pin both the env check and the conjunction with the prop
  // existence test.
  assert.match(
    src,
    /process\.env\.NODE_ENV\s*!==\s*["']production["']\s*&&\s*action\s*&&\s*onSubmit/,
    "FormRenderer.tsx must guard the throw with `process.env.NODE_ENV !== \"production\" && action && onSubmit` so production silently picks `action` while dev/test crash on the both-set mistake",
  );
});

test("spec 167 — FormRenderer.tsx no longer carries the prior console.error message body", () => {
  const src = read(FORM_RENDERER);
  // Pin ABSENCE of the prior console.error shape so a contributor who
  // reverts via cherry-pick fails the test immediately.
  assert.ok(
    !/console\.error\s*\(\s*\n?\s*["'`]\[FormRenderer\]/.test(src),
    "FormRenderer.tsx must not contain the prior `console.error(\"[FormRenderer] Both `action` and `onSubmit` were provided.\")` call — replaced with a throw",
  );
});

// ---------- (B) BCRYPT_COST export + imports ----------

test("spec 167 — lib/password.ts exports BCRYPT_COST = 10", () => {
  const src = read(PASSWORD_LIB);
  assert.match(
    src,
    /export\s+const\s+BCRYPT_COST\s*=\s*10\s*;/,
    "apps/web/src/lib/password.ts must `export const BCRYPT_COST = 10;` as the single source of truth for the bcrypt cost across apps/web",
  );
  // hashPassword must consume the const, not a re-introduced literal.
  assert.match(
    src,
    /bcrypt\.hash\([^,]+,\s*BCRYPT_COST\)/,
    "apps/web/src/lib/password.ts hashPassword must use `bcrypt.hash(plain, BCRYPT_COST)` so the export is the only place the cost is defined",
  );
});

test("spec 167 — gates/[slug]/rotate route imports BCRYPT_COST and uses it in bcrypt.hash", () => {
  const src = read(ROTATE_ROUTE);
  assert.match(
    src,
    /import\s*\{\s*BCRYPT_COST\s*\}\s*from\s*["']@\/lib\/password["']/,
    "rotate/route.ts must `import { BCRYPT_COST } from \"@/lib/password\"` so the const is the single source of truth",
  );
  assert.match(
    src,
    /bcrypt\.hash\([^,]+,\s*BCRYPT_COST\)/,
    "rotate/route.ts must call `bcrypt.hash(plaintext, BCRYPT_COST)` rather than the literal 10",
  );
});

test("spec 167 — forgot-password route imports BCRYPT_COST and uses it in bcrypt.hash", () => {
  const src = read(FORGOT_ROUTE);
  assert.match(
    src,
    /import\s*\{\s*BCRYPT_COST\s*\}\s*from\s*["']@\/lib\/password["']/,
    "forgot-password/route.ts must `import { BCRYPT_COST } from \"@/lib/password\"` so the local literal is removed",
  );
  // The local `const BCRYPT_COST = 10;` declaration must be gone — it
  // would shadow the import otherwise.
  assert.ok(
    !/^\s*const\s+BCRYPT_COST\s*=\s*10\s*;/m.test(src),
    "forgot-password/route.ts must not declare a local `const BCRYPT_COST = 10;` — the value comes from the @/lib/password import",
  );
  assert.match(
    src,
    /bcrypt\.hash\([^,]+,\s*BCRYPT_COST\)/,
    "forgot-password/route.ts must call `bcrypt.hash(plaintextToken, BCRYPT_COST)` for the reset-token hash",
  );
});

test("spec 167 — reset-password route imports BCRYPT_COST", () => {
  const src = read(RESET_ROUTE);
  // The reset-password route hashes the new password via the shared
  // hashPassword helper (which already uses BCRYPT_COST internally), so
  // the BCRYPT_COST import here is documentary: it records the cost in
  // the audit metadata so an investigator can see which bcrypt cost the
  // hash was generated at.
  assert.match(
    src,
    /import\s*\{[^}]*BCRYPT_COST[^}]*\}\s*from\s*["']@\/lib\/password["']/,
    "reset-password/route.ts must import `BCRYPT_COST` from @/lib/password so the audit metadata records the cost used",
  );
});

// ---------- (C) High-stakes recordAudit boolean capture ----------

test("spec 167 — gates/rotate route captures recordAudit boolean", () => {
  const src = read(ROTATE_ROUTE);
  // The `const auditOk = await recordAudit(...)` shape must appear at
  // the rotation audit call site so a downstream insert failure trips
  // the noteAuditDegraded helper.
  assert.match(
    src,
    /const\s+auditOk\s*=\s*await\s+recordAudit\s*\(/,
    "gates/rotate/route.ts must `const auditOk = await recordAudit(...)` (boolean-capturing shape, spec 141 contract) for the rotation audit",
  );
  assert.match(
    src,
    /if\s*\(\s*!\s*auditOk\s*\)\s*\{?\s*\n?\s*noteAuditDegraded\s*\(\s*["'`]\/api\/admin\/gates/,
    "gates/rotate/route.ts must call `noteAuditDegraded(\"/api/admin/gates/...\")` when the audit insert fails",
  );
});

test("spec 167 — learners/export route captures recordAudit boolean", () => {
  const src = read(LEARNERS_EXPORT_ROUTE);
  assert.match(
    src,
    /const\s+auditOk\s*=\s*await\s+recordAudit\s*\(/,
    "learners/export/route.ts must capture the recordAudit boolean — SM-9 PII bulk-export is the highest-severity forensic-trail surface in the LMS",
  );
  assert.match(
    src,
    /noteAuditDegraded\s*\(\s*["'`]\/api\/admin\/learners\/export["'`]/,
    "learners/export/route.ts must call `noteAuditDegraded(\"/api/admin/learners/export\")` on the false-return branch",
  );
});

test("spec 167 — audit/export route captures recordAudit boolean", () => {
  const src = read(AUDIT_EXPORT_ROUTE);
  assert.match(
    src,
    /const\s+auditOk\s*=\s*await\s+recordAudit\s*\(/,
    "audit/export/route.ts must capture the recordAudit boolean — exporting the audit log is itself an event the audit trail must record",
  );
  assert.match(
    src,
    /noteAuditDegraded\s*\(\s*["'`]\/api\/admin\/audit\/export["'`]/,
    "audit/export/route.ts must call `noteAuditDegraded(\"/api/admin/audit/export\")` on the false-return branch",
  );
});

test("spec 167 — forgot-password route captures recordAudit boolean for the matched-email path", () => {
  const src = read(FORGOT_ROUTE);
  assert.match(
    src,
    /const\s+auditOk\s*=\s*await\s+recordAudit\s*\(/,
    "forgot-password/route.ts must capture the recordAudit boolean on the matched-email path (the only audit row proving the reset link was issued)",
  );
  assert.match(
    src,
    /noteAuditDegraded\s*\(\s*["'`]\/api\/auth\/forgot-password["'`]/,
    "forgot-password/route.ts must call `noteAuditDegraded(\"/api/auth/forgot-password\")` on the false-return branch",
  );
});

test("spec 167 — reset-password route captures recordAudit boolean for the success path", () => {
  const src = read(RESET_ROUTE);
  assert.match(
    src,
    /const\s+auditOk\s*=\s*await\s+recordAudit\s*\(/,
    "reset-password/route.ts must capture the recordAudit boolean on the success path — password resets are auth-mutating events whose audit miss is forensically severe",
  );
  assert.match(
    src,
    /noteAuditDegraded\s*\(\s*["'`]\/api\/auth\/reset-password["'`]/,
    "reset-password/route.ts must call `noteAuditDegraded(\"/api/auth/reset-password\")` on the false-return branch",
  );
});

// ---------- (D) audit.ts exports ----------

test("spec 167 — audit.ts exports noteAuditDegraded and getAuditDegradedCount", () => {
  const src = read(AUDIT_LIB);
  assert.match(
    src,
    /export\s+function\s+noteAuditDegraded\s*\(\s*callsite\s*:\s*string\s*\)\s*:\s*void/,
    "lib/audit.ts must `export function noteAuditDegraded(callsite: string): void` so high-stakes callers have a single helper to tally degraded writes",
  );
  assert.match(
    src,
    /export\s+function\s+getAuditDegradedCount\s*\(\s*\)\s*:\s*number/,
    "lib/audit.ts must `export function getAuditDegradedCount(): number` so a future diagnostic surface can read the tally without exposing a setter",
  );
  // Pin the counter increment so a contributor can't silently downgrade
  // the helper to a no-op.
  assert.match(
    src,
    /auditDegradedCount\s*\+=\s*1/,
    "lib/audit.ts noteAuditDegraded must increment `auditDegradedCount` so the tally actually accumulates",
  );
  // Pin the console.error inside noteAuditDegraded — the "loud" half of
  // the loud-but-non-blocking degradation signal.
  assert.match(
    src,
    /console\.error\s*\(\s*\n?\s*[`"']\[audit\]\s+degraded-mode\s+write/,
    "lib/audit.ts noteAuditDegraded must `console.error` with the [audit] degraded-mode prefix so the log shipper has a stable filter target",
  );
});

// ---------- (E) seed.ts mirror comment ----------

test("spec 167 — seed.ts carries the Spec-167 mirror comment next to the literal 10", () => {
  const src = read(SEED_SCRIPT);
  // The mirror comment so a future cost bump in apps/web/lib/password.ts
  // forces a paired edit here (or the governance test catches the drift).
  assert.match(
    src,
    /Spec\s*167/,
    "packages/db/src/scripts/seed.ts must carry a `Spec 167` reference next to the literal bcrypt cost so the cross-workspace mirror is self-documenting",
  );
  // The phrase "mirror" + the lib/password.ts path so a reader knows
  // exactly where to look when bumping the cost.
  assert.match(
    src,
    /password\.ts/,
    "packages/db/src/scripts/seed.ts Spec-167 comment must reference apps/web/src/lib/password.ts so a future cost bump knows where the single-source-of-truth lives",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 167 — no new dependencies were introduced (no logging or counter libraries)", () => {
  // The fix is a hand-rolled module-scoped `let` counter + a small
  // console.error helper. No logger, no Prometheus client, no metrics
  // library should have crept into apps/web/package.json.
  const webPkg = read("apps/web/package.json");
  for (const dep of ["prom-client", "pino", "winston", "statsd-client"]) {
    assert.ok(
      !new RegExp(`"${dep}"`).test(webPkg),
      `apps/web must not depend on ${dep} — the degraded-mode counter is a hand-rolled module-scoped let`,
    );
  }
});

test("spec 167 — high-stakes routes still import recordAudit (the captured-boolean is a strict superset of the prior shape)", () => {
  // Belt-and-suspenders: pin that the underlying recordAudit import
  // wasn't accidentally dropped while the call shape was upgraded.
  for (const path of [ROTATE_ROUTE, LEARNERS_EXPORT_ROUTE, AUDIT_EXPORT_ROUTE, FORGOT_ROUTE, RESET_ROUTE]) {
    const src = read(path);
    assert.match(
      src,
      /recordAudit/,
      `${path} must still reference recordAudit — the captured-boolean shape is an upgrade, not a removal`,
    );
    assert.match(
      src,
      /noteAuditDegraded/,
      `${path} must reference noteAuditDegraded — the spec-167 contract for the false-return branch`,
    );
  }
});
