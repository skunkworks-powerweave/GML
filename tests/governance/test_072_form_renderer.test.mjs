// Spec 072 — Generic FormRenderer + draft autosave pipeline.
//
// Source-level assertions (no DB / no browser). Each test reads the produced
// file and asserts the expected behaviours are present. The full integration
// surface lands in specs 074 (feedback-runner) and 075 (observation-runner)
// which consume this renderer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const RENDERER = "apps/web/src/components/forms/FormRenderer.tsx";
const LIB = "apps/web/src/lib/form-draft.ts";
const ROUTE = "apps/web/src/app/api/form-drafts/[id]/route.ts";

test("072 — three target files exist", () => {
  assert.ok(existsSync(resolve(root, RENDERER)), `${RENDERER} must exist`);
  assert.ok(existsSync(resolve(root, LIB)), `${LIB} must exist`);
  assert.ok(existsSync(resolve(root, ROUTE)), `${ROUTE} must exist`);
});

test("072 — FormRenderer is a client component exporting FormRenderer + FormSchema types", () => {
  const src = read(RENDERER);
  assert.match(src, /^\s*"use client";/m, "must declare 'use client'");
  assert.match(src, /export\s+function\s+FormRenderer\s*\(/, "must export FormRenderer function");
  assert.match(src, /export\s+type\s+FormSchema/, "must export FormSchema type");
  assert.match(src, /export\s+type\s+FormField/, "must export FormField type");
  assert.match(src, /export\s+type\s+FieldKind/, "must export FieldKind type");
});

test("072 — FormRenderer handles all 9 field kinds", () => {
  const src = read(RENDERER);
  for (const kind of [
    "text",
    "textarea",
    "select",
    "radio",
    "checkbox",
    "number",
    "date",
    "likert",
    "rating",
  ]) {
    assert.match(src, new RegExp(`["']${kind}["']`), `must reference field kind '${kind}'`);
  }
});

test("072 — FormRenderer wires autosave (1 s debounce) + saved-indicator ticker", () => {
  const src = read(RENDERER);
  assert.match(src, /AUTOSAVE_DEBOUNCE_MS\s*=\s*1000/, "1 s debounce constant");
  assert.match(src, /setTimeout\(/, "must use setTimeout for debounce");
  assert.match(src, /setInterval\(/, "must use setInterval for live 'saved Ns ago'");
  assert.match(src, /saveDraft\(/, "must call saveDraft");
  assert.match(src, /clearDraft\(/, "must call clearDraft on submit success");
  assert.match(src, /Saved\s.*ago/, "must render 'Saved Ns ago' indicator copy");
});

test("072 — FormRenderer honours SM-7 Hindi-name font and required marker styling", () => {
  const src = read(RENDERER);
  assert.match(src, /var\(--deva\)/, "Hindi-name fields must use --deva font");
  assert.match(src, /hi\|hindi/i, "must detect _hi / _hindi field-name suffix");
  assert.match(src, /var\(--rust\)/, "required marker / error text must use --rust");
  assert.match(src, /aria-required/, "must wire aria-required for a11y");
  assert.match(src, /role="alert"/, "error text must have role='alert'");
});

test("072 — form-draft lib exports loadDraft, saveDraft, clearDraft and validates scope", () => {
  const src = read(LIB);
  assert.match(src, /export\s+async\s+function\s+loadDraft/);
  assert.match(src, /export\s+async\s+function\s+saveDraft/);
  assert.match(src, /export\s+async\s+function\s+clearDraft/);
  assert.match(src, /scope=\$\{scoped\.scope\}|scope=template|scope=cycle/, "must thread scope into URL");
  assert.match(src, /"template"/, "must reference template scope literal");
  assert.match(src, /"cycle"/, "must reference cycle scope literal");
  assert.match(
    src,
    /exactly one of/i,
    "must reject calls without exactly one of templateId / observationCycleId",
  );
});

test("072 — /api/form-drafts/[id] route exports GET/PUT/DELETE with zod + audit + dynamic", () => {
  const src = read(ROUTE);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /export\s+async\s+function\s+GET\b/);
  assert.match(src, /export\s+async\s+function\s+PUT\b/);
  assert.match(src, /export\s+async\s+function\s+DELETE\b/);
  assert.match(src, /from\s+"zod"/, "must use zod");
  assert.match(src, /recordAudit/, "must call recordAudit");
  assert.match(src, /form\.draft\.save/, "must record form.draft.save audit event");
  assert.match(src, /form\.draft\.clear/, "must record form.draft.clear audit event");
  assert.match(src, /auth\(\)/, "must check authenticated session via auth()");
  assert.match(src, /onConflictDoUpdate/, "must upsert via onConflictDoUpdate");
});

test("072 — route imports follow @gml/db conventions", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s+\{\s*db\s*\}\s+from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /formDrafts/);
});

test("072 — spec-kit deliverables present", () => {
  for (const f of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, "specs/072-form-renderer", f)),
      `specs/072-form-renderer/${f} must exist`,
    );
  }
});
