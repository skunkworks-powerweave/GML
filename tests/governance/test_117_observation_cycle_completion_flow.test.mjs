// Governance test for spec 117 — observation-cycle-completion-flow.
//
// Six CTA wires under audit:
//   1. submitPreFormAction       (nominated      → pre_submitted)
//   2. submitObserverFormAction  (pre_submitted  → observed)
//   3. submitPostFormAction      (observed       → post_submitted)
//   4. signOffCycleAction        (post_submitted → complete)
//   5. addNoteAction             (updates observation_cycles.remark)
//   6. video upload context wire (<UploadProgress contextType="observation_cycle" contextId={cycleId} />)
//
// Each is asserted against the actions file + the page that consumes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ACTIONS_PATH = "apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts";
const PAGE_PATH = "apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx";

test("spec 117 — actions.ts exists and declares use-server", () => {
  assert.ok(existsSync(resolve(root, ACTIONS_PATH)), `${ACTIONS_PATH} must exist`);
  const src = read(ACTIONS_PATH);
  assert.match(src, /^\s*"use server"/m, "actions.ts must declare 'use server' at top");
});

test("spec 117 — page.tsx exists and imports the five server actions", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"\.\/actions"/);
  assert.match(src, /submitPreFormAction/);
  assert.match(src, /submitObserverFormAction/);
  assert.match(src, /submitPostFormAction/);
  assert.match(src, /signOffCycleAction/);
  assert.match(src, /addNoteAction/);
});

test("spec 117 — all five actions are exported from actions.ts", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /export async function submitPreFormAction/);
  assert.match(src, /export async function submitObserverFormAction/);
  assert.match(src, /export async function submitPostFormAction/);
  assert.match(src, /export async function signOffCycleAction/);
  assert.match(src, /export async function addNoteAction/);
});

test("spec 117 — actions.ts uses requireRole from @/lib/guards", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /from\s+"@\/lib\/guards"/);
  // Each of the five actions reaches into requireRole at least once.
  const reqMatches = src.match(/requireRole\(/g) ?? [];
  assert.ok(reqMatches.length >= 5, `requireRole must be called per action (got ${reqMatches.length})`);
});

test("spec 117 — sign-off action has the high-trust role gate (no teacher, no observer)", () => {
  const src = read(ACTIONS_PATH);
  // Capture the signOffCycleAction body up to the next 'export async function'
  // boundary or end of file, then assert teacher/observer are NOT in that slice.
  const m = src.match(/export async function signOffCycleAction[\s\S]*?(?=export async function|$)/);
  assert.ok(m, "signOffCycleAction body must be locatable");
  const body = m[0];
  assert.match(body, /requireRole\(\s*\[[\s\S]*?"mentor"/);
  assert.match(body, /"programme_admin"/);
  assert.match(body, /"super_admin"/);
  assert.doesNotMatch(body, /"teacher"/);
  // The observer role IS allowed elsewhere (observer form), but the sign-off
  // role list must omit observer per D-004.
  const allowList = body.match(/requireRole\(\s*\[([\s\S]*?)\]/);
  assert.ok(allowList, "must find requireRole call inside signOffCycleAction");
  assert.doesNotMatch(allowList[1], /"observer"/, "observer must not be in sign-off role list");
});

test("spec 117 — all transitions go through a guarded UPDATE with status in WHERE clause", () => {
  const src = read(ACTIONS_PATH);
  // The helper performs an atomic UPDATE ... WHERE id = ? AND status = ? RETURNING ...
  assert.match(src, /\.update\(observationCycles\)/);
  assert.match(src, /\.set\(\{[\s\S]*?status:\s*to/);
  assert.match(src, /eq\(observationCycles\.status,\s*from\)/);
  assert.match(src, /\.returning\(\{\s*code:\s*observationCycles\.code\s*\}\)/);
  // Zero-rows path → invalid_transition redirect.
  assert.match(src, /invalid_transition/);
  assert.match(src, /updated\.length\s*===\s*0/);
});

test("spec 117 — pre/post/observer inserts route through observation_forms with the right kind", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /db\s*\.\s*insert\(observationForms\)/);
  assert.match(src, /kind:\s*"pre"/);
  assert.match(src, /kind:\s*"post"/);
  assert.match(src, /kind:\s*"observer"/);
  // Each form insert chains .onConflictDoNothing for idempotence on (cycleId, kind).
  const conflictMatches = src.match(/\.onConflictDoNothing\(\)/g) ?? [];
  assert.ok(conflictMatches.length >= 3, `.onConflictDoNothing must guard each form insert (got ${conflictMatches.length})`);
});

test("spec 117 — each action calls recordAudit with the correct dotted action name", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /action:\s*"observation\.pre_form\.submitted"/);
  assert.match(src, /action:\s*"observation\.observer_form\.submitted"/);
  assert.match(src, /action:\s*"observation\.post_form\.submitted"/);
  assert.match(src, /action:\s*"observation\.signed_off"/);
  assert.match(src, /action:\s*"observation\.note\.added"/);
  // Best-effort void prefix so audit failure doesn't block the user flow.
  const voidMatches = src.match(/void\s+recordAudit/g) ?? [];
  assert.ok(voidMatches.length >= 5, `recordAudit must be void-prefixed in all 5 actions (got ${voidMatches.length})`);
});

test("spec 117 — sign-off audit metadata carries signedByUserId and signedAt", () => {
  const src = read(ACTIONS_PATH);
  const m = src.match(/action:\s*"observation\.signed_off"[\s\S]*?\}\s*\)/);
  assert.ok(m, "sign-off recordAudit block must be locatable");
  assert.match(m[0], /signedByUserId/);
  assert.match(m[0], /signedAt/);
  assert.match(m[0], /entityType:\s*"observation_cycle"/);
  assert.match(m[0], /entityId:\s*cycleId/);
});

test("spec 117 — addNoteAction persists into observation_cycles.remark and rejects empty notes", () => {
  const src = read(ACTIONS_PATH);
  const m = src.match(/export async function addNoteAction[\s\S]*$/);
  assert.ok(m, "addNoteAction body must be locatable");
  const body = m[0];
  // Sets the remark column on the cycle.
  assert.match(body, /\.update\(observationCycles\)/);
  assert.match(body, /remark:\s*note/);
  // Empty-note guard → redirect with ?error=empty_note.
  assert.match(body, /empty_note/);
  // Audit hook fires the dotted action name.
  assert.match(body, /observation\.note\.added/);
});

test("spec 117 — page mounts UploadProgress with observation_cycle context wired to cycleId", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/components\/video\/UploadProgress"/);
  assert.match(src, /<UploadProgress[\s\S]*?contextType=["']observation_cycle["']/);
  assert.match(src, /<UploadProgress[\s\S]*?contextId=\{cycleId\}/);
});

test("spec 117 — page gates each CTA by the current cycle status", () => {
  const src = read(PAGE_PATH);
  // Pre-form gate: status === 'nominated'
  assert.match(src, /canSubmitPre\s*=\s*cycle\.status\s*===\s*"nominated"/);
  // Observer-form gate: status === 'pre_submitted'
  assert.match(src, /canSubmitObserver\s*=\s*cycle\.status\s*===\s*"pre_submitted"/);
  // Post-form gate: status === 'observed'
  assert.match(src, /canSubmitPost\s*=\s*cycle\.status\s*===\s*"observed"/);
  // Sign-off gate: status === 'post_submitted'
  assert.match(src, /canSignOff\s*=\s*cycle\.status\s*===\s*"post_submitted"/);
});

test("spec 117 — page renders native server-action forms (no use-client boundary needed)", () => {
  const src = read(PAGE_PATH);
  // Each CTA renders as <form action={...}>; no "use client" directive.
  assert.doesNotMatch(src, /^\s*"use client"/m);
  assert.match(src, /<form action=\{submitPreFormAction\}/);
  assert.match(src, /<form action=\{submitObserverFormAction\}/);
  assert.match(src, /<form action=\{submitPostFormAction\}/);
  assert.match(src, /<form action=\{signOffCycleAction\}/);
  assert.match(src, /<form action=\{addNoteAction\}/);
  // Hidden cycleId field on each form so the server action knows the cycle.
  const hiddenMatches = src.match(/<input\s+type="hidden"\s+name="cycleId"/g) ?? [];
  assert.ok(hiddenMatches.length >= 5, `each form must carry cycleId hidden field (got ${hiddenMatches.length})`);
});

test("spec 117 — actions revalidate + redirect back to /observation/[cycleId]", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /from\s+"next\/cache"/);
  assert.match(src, /revalidatePath\(`\/observation\/\$\{cycleId\}`\)/);
  const redirectMatches = src.match(/redirect\(`\/observation\/\$\{cycleId\}`\)/g) ?? [];
  assert.ok(redirectMatches.length >= 5, `each action must redirect back to the cycle page (got ${redirectMatches.length})`);
});

test("spec 117 — imports use locked workspace packages, no new deps", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /from\s+"drizzle-orm"/);
  assert.match(src, /from\s+"next\/navigation"/);
  assert.match(src, /from\s+"next\/cache"/);
});
