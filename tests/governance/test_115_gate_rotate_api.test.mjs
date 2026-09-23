// Governance test for spec 115 — section-gate password rotation API + admin UI.
//
// Asserts:
//   - /api/admin/gates/[slug]/rotate/route.ts ships with POST handler, super_admin
//     role gate, slug validation, crypto.randomBytes password gen, bcrypt cost 10,
//     section_gates INSERT, section_gate_grants mass DELETE, and the
//     gate.password.rotated audit row.
//   - /api/admin/gates/[slug]/share/route.ts companion ships with zod body
//     validation, recipient phone lookup, wa.me URL composition, and the
//     gate.password.share_initiated audit row (without the plaintext in
//     metadata).
//   - /admin/gates/page.tsx is a server component, gates by super_admin only,
//     and hands the per-row UX to a client RotateControls component.
//   - /admin index page links to /admin/gates (not the placeholder).
//   - All five spec-kit files exist under specs/115-gate-rotate-api/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/**
 * Comments stripped, so prose about a construct is not evidence the construct
 * is there. The rotate audit-shape assertion below used to match the comment at
 * rotate/route.ts:172 that records the `void recordAudit(...)` → captured-
 * boolean upgrade, so it could not have failed if the audit call were deleted.
 * The `[^:]` guard keeps a "https://" inside a string from reading as a comment
 * start.
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ROTATE_PATH = "apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts";
const SHARE_PATH = "apps/web/src/app/api/admin/gates/[slug]/share/route.ts";
const PAGE_PATH = "apps/web/src/app/(authenticated)/admin/gates/page.tsx";
const CONTROLS_PATH =
  "apps/web/src/app/(authenticated)/admin/gates/rotate-controls.tsx";
const ADMIN_INDEX_PATH = "apps/web/src/app/(authenticated)/admin/page.tsx";

test("spec 115 — rotate route file exists at /api/admin/gates/[slug]/rotate", () => {
  assert.ok(existsSync(resolve(root, ROTATE_PATH)), `${ROTATE_PATH} must exist`);
});

test("spec 115 — share route file exists at /api/admin/gates/[slug]/share", () => {
  assert.ok(existsSync(resolve(root, SHARE_PATH)), `${SHARE_PATH} must exist`);
});

test("spec 115 — /admin/gates page + RotateControls client component exist", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  assert.ok(
    existsSync(resolve(root, CONTROLS_PATH)),
    `${CONTROLS_PATH} must exist`,
  );
});

test("spec 115 — rotate exports POST handler and 405 stubs for other methods", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /export async function POST/);
  assert.match(src, /export async function GET/);
  assert.match(src, /method_not_allowed/);
  assert.match(src, /status:\s*405/);
});

test("spec 115 — rotate auth gate: session check returns 401 unauthenticated", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /await\s+auth\(\)/);
  assert.match(src, /unauthenticated/);
  assert.match(src, /status:\s*401/);
});

test("spec 115 — rotate role gate is super_admin ONLY (no programme_admin)", () => {
  const src = read(ROTATE_PATH);
  // Strip block comments and line comments before searching, so the role-gate
  // grep can't be fooled by an explanatory comment that mentions
  // programme_admin in prose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[^\n]*\/\/.*$/gm, "");
  assert.match(code, /"super_admin"/);
  assert.doesNotMatch(
    code,
    /"programme_admin"/,
    "rotate must NOT list programme_admin as an allowed role",
  );
  assert.match(src, /forbidden/);
  assert.match(src, /status:\s*403/);
});

test("spec 115 — rotate validates slug against the section_gate_slug enum", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /"mentorship"/);
  assert.match(src, /"observation"/);
  assert.match(src, /"tkt"/);
  assert.match(src, /"ttt"/);
  assert.match(src, /"admin"/);
  assert.match(src, /invalid_slug/);
  assert.match(src, /status:\s*400/);
});

test("spec 115 — rotate generates password via crypto.randomBytes + bcrypt cost 10", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /from\s+"node:crypto"/);
  assert.match(src, /randomBytes\(/);
  assert.match(src, /from\s+"bcryptjs"/);
  // Spec 167 — the literal `10` became the exported `BCRYPT_COST` const
  // (apps/web/src/lib/password.ts is the single source of truth for the
  // bcrypt cost across apps/web). Accept either the historical literal or
  // the spec-167 import so this regression test pins the bcrypt-hash call
  // shape without forbidding the const-ification cleanup.
  assert.match(src, /bcrypt\.hash\([^,]+,\s*(?:10|BCRYPT_COST)\)/);
});

test("spec 115 — rotate INSERTs new section_gates row with bumped version", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /sectionGates/);
  // Spec 148 wrapped this in a db.transaction so the call site is now
  // tx.insert(sectionGates) rather than db.insert(sectionGates). Either
  // prefix satisfies spec 115's intent (a write to section_gates as part of
  // the rotation path).
  assert.match(src, /(?:db|tx)\s*\.\s*insert\(\s*sectionGates\s*\)/);
  // Version-bump computation
  assert.match(src, /max\(/);
  assert.match(src, /version/);
  assert.match(src, /rotatedByUserId/);
});

test("spec 115 — rotate DELETEs section_gate_grants for the slug to invalidate active grants", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /sectionGateGrants/);
  // Spec 148 wrapped this in a db.transaction so the call site is now
  // tx.delete(sectionGateGrants) rather than db.delete(sectionGateGrants).
  // Either prefix satisfies spec 115's intent (mass-DELETE of active grants
  // for the slug as part of the rotation path).
  assert.match(src, /(?:db|tx)\s*\.\s*delete\(\s*sectionGateGrants\s*\)/);
  assert.match(src, /eq\(\s*sectionGateGrants\.gateSlug/);
  assert.match(src, /\.returning\(/);
});

test("spec 115 — rotate audit fires gate.password.rotated with version + grantsInvalidated metadata", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /action:\s*"gate\.password\.rotated"/);
  assert.match(src, /entityType:\s*"section_gate"/);
  assert.match(src, /grantsInvalidated/);
  // Best-effort with respect to the 200: audit failure never blocks the
  // rotation response. Spec 167 replaced `void recordAudit(...)` here with a
  // captured-boolean `const auditOk = await recordAudit(...)` feeding
  // noteAuditDegraded, so accept either — against the comment-stripped view,
  // because the only `void recordAudit` text left in this route is the comment
  // describing that upgrade.
  assert.match(
    code(src),
    /(?:void\s+recordAudit|const\s+auditOk\s*=\s*await\s+recordAudit)/,
  );
});

test("spec 115 — rotate response carries plaintext + version + ok:true on 200", () => {
  const src = read(ROTATE_PATH);
  assert.match(src, /plaintext/);
  assert.match(src, /ok:\s*true/);
  assert.match(src, /status:\s*200/);
  assert.match(src, /version/);
});

test("spec 115 — share route exports POST + 405 stubs, gates by super_admin", () => {
  const src = read(SHARE_PATH);
  assert.match(src, /export async function POST/);
  assert.match(src, /export async function GET/);
  assert.match(src, /method_not_allowed/);
  assert.match(src, /status:\s*405/);
  // Strip comments before role-gate grep.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[^\n]*\/\/.*$/gm, "");
  assert.match(code, /"super_admin"/);
  assert.doesNotMatch(code, /"programme_admin"/);
});

test("spec 115 — share validates body with zod and looks up recipient phone", () => {
  const src = read(SHARE_PATH);
  assert.match(src, /from\s+"zod"/);
  assert.match(src, /recipientUserId/);
  assert.match(src, /channel/);
  assert.match(src, /"whatsapp"/);
  assert.match(src, /users\.phone/);
  assert.match(src, /recipient_no_phone/);
});

test("spec 115 — share composes a wa.me/<phone>?text=... URL and audits the intent", () => {
  const src = read(SHARE_PATH);
  assert.match(src, /wa\.me\//);
  assert.match(src, /encodeURIComponent/);
  assert.match(src, /action:\s*"gate\.password\.share_initiated"/);
  assert.match(src, /void\s+recordAudit/);
});

test("spec 115 — share does NOT persist plaintext in audit metadata", () => {
  const src = read(SHARE_PATH);
  // The plaintext should never appear inside a metadata: { ... plaintext ... }
  // payload. We grep the source for `metadata:` blocks and assert none of
  // them contain a `plaintext` field.
  const metadataBlocks = src.match(/metadata:\s*\{[^}]*\}/g) ?? [];
  for (const block of metadataBlocks) {
    assert.doesNotMatch(
      block,
      /plaintext/,
      `share audit metadata must not contain the plaintext password: ${block}`,
    );
  }
});

test("spec 115 — admin gates page gates by super_admin only via requireRole", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/lib\/guards"/);
  assert.match(src, /requireRole\(\s*\[\s*"super_admin"\s*\]\s*\)/);
  // The page must not weaken the gate by including programme_admin.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[^\n]*\/\/.*$/gm, "");
  // requireRole signature is `requireRole(["super_admin"])`; we already
  // assert that. Also assert programme_admin is not inside a requireRole call.
  const requireRoleBlocks = code.match(/requireRole\([^)]+\)/g) ?? [];
  for (const block of requireRoleBlocks) {
    assert.doesNotMatch(
      block,
      /programme_admin/,
      `requireRole on /admin/gates must not include programme_admin: ${block}`,
    );
  }
});

test("spec 115 — admin gates page records gate.password.surface_viewed audit and imports RotateControls", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /action:\s*"gate\.password\.surface_viewed"/);
  assert.match(src, /from\s+"\.\/rotate-controls"/);
  assert.match(src, /RotateControls/);
});

test("spec 115 — RotateControls client component POSTs to /rotate and /share endpoints", () => {
  const src = read(CONTROLS_PATH);
  assert.match(src, /"use client"/);
  assert.match(src, /\/api\/admin\/gates\/.+\/rotate/);
  assert.match(src, /\/api\/admin\/gates\/.+\/share/);
  assert.match(src, /method:\s*"POST"/);
  // Confirm dialog before destructive rotate
  assert.match(src, /confirm\(/);
});

test("spec 115 — /admin index page links to /admin/gates (no longer a placeholder)", () => {
  const src = read(ADMIN_INDEX_PATH);
  assert.match(src, /href="\/admin\/gates"/);
  // The placeholder text from the previous version should be gone.
  assert.doesNotMatch(
    src,
    /Lands in spec 021 \/ 035/,
    "the old Section gates placeholder copy must be gone",
  );
});

test("spec 115 — both routes declare dynamic=force-dynamic and import the locked workspace packages", () => {
  for (const p of [ROTATE_PATH, SHARE_PATH]) {
    const src = read(p);
    assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
    assert.match(src, /from\s+"@gml\/db"/);
    assert.match(src, /from\s+"@gml\/db\/schema"/);
    assert.match(src, /from\s+"next\/server"/);
    assert.match(src, /from\s+"drizzle-orm"/);
  }
});

test("spec 115 — all five spec-kit files exist under specs/115-gate-rotate-api/", () => {
  const SPEC_DIR = "specs/115-gate-rotate-api";
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});
