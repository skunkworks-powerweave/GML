// Governance test for spec 135 — Mobile upload runner
// (Workflow Run 12 final frontend parity).
//
// Two files under audit:
//
//   1. apps/web/src/components/video/MobileUploadRunner.tsx
//      — new "use client" component that ports the JSX prototype's
//        MobUpload (mobile-runners.jsx lines 181-294) into production.
//        Five-state machine, two file inputs (camera + gallery), tus
//        upload, redirect to /uploads on success.
//   2. apps/web/src/app/(authenticated)/uploads/page.tsx
//      — edited to call getDeviceType() server-side and conditionally
//        render MobileUploadRunner on mobile, leaving the existing
//        three-card explainer + UploadProgress tray for desktop.
//
// Plus the five spec-kit files under specs/135-mobile-upload-runner/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const RUNNER_PATH = "apps/web/src/components/video/MobileUploadRunner.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/uploads/page.tsx";
const SPEC_DIR = "specs/135-mobile-upload-runner";

test("spec 135 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile-upload-runner spec`,
    );
  }
});

test("spec 135 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileUploadRunner\.tsx/,
    "plan.md must call out the new MobileUploadRunner component in CREATED",
  );
  assert.match(
    src,
    /uploads\/page\.tsx/,
    "plan.md must call out the uploads page edit",
  );
});

test("spec 135 — MobileUploadRunner.tsx exists and is a client component", () => {
  assert.ok(existsSync(resolve(root, RUNNER_PATH)), `${RUNNER_PATH} must exist`);
  const src = read(RUNNER_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "MobileUploadRunner must declare 'use client' — owns useState + useEffect + useRouter",
  );
  assert.match(
    src,
    /export function MobileUploadRunner/,
    "MobileUploadRunner must export a named function so server pages can import it",
  );
  assert.match(
    src,
    /whatsappPhone\??:\s*string\s*\|\s*null/,
    "MobileUploadRunner must accept a whatsappPhone string-or-null prop",
  );
});

test("spec 135 — MobileUploadRunner.tsx lifts MOBILE_TILES to a module-level const", () => {
  const src = read(RUNNER_PATH);
  // The const declaration must be at module level (not inside the
  // component) so the test can pin the two-tile contract without
  // parsing JSX. Both tile ids (record + pick) must appear in the literal.
  assert.match(
    src,
    /export const MOBILE_TILES\s*=\s*\[/,
    "MOBILE_TILES must be exported as a module-level const for downstream coverage",
  );
  const constIdx = src.indexOf("export const MOBILE_TILES");
  const fnIdx = src.indexOf("export function MobileUploadRunner");
  assert.ok(constIdx > 0, "MOBILE_TILES must be declared somewhere in the file");
  assert.ok(fnIdx > 0, "export function MobileUploadRunner must exist");
  assert.ok(
    constIdx < fnIdx,
    "MOBILE_TILES must be a module-level const declared before the component",
  );
  // The two tile ids must both be present.
  assert.match(src, /id:\s*"record"/, "MOBILE_TILES must include the record tile");
  assert.match(src, /id:\s*"pick"/, "MOBILE_TILES must include the pick tile");
});

test("spec 135 — MobileUploadRunner.tsx wires the camera + gallery file inputs", () => {
  const src = read(RUNNER_PATH);
  // Two inputs: one with capture="environment" (record), one without (gallery).
  assert.match(
    src,
    /capture="environment"/,
    "MobileUploadRunner must declare a file input with capture=environment so phones open the camera",
  );
  assert.match(
    src,
    /accept="video\/\*"/,
    "MobileUploadRunner must restrict file picker to video/* MIME types",
  );
  // Camera input testid.
  assert.match(
    src,
    /data-testid="camera-input"/,
    "the camera input must carry a data-testid='camera-input' so e2e can target it",
  );
  // Gallery input testid.
  assert.match(
    src,
    /data-testid="gallery-input"/,
    "the gallery input must carry a data-testid='gallery-input' so e2e can target it",
  );
});

test("spec 135 — MobileUploadRunner.tsx meets the 56px touch-target minimum", () => {
  const src = read(RUNNER_PATH);
  // The two main tiles must be at least 56px tall (Apple HIG / Material).
  assert.match(
    src,
    /minHeight:\s*56/,
    "the two primary tiles must declare minHeight: 56 (touch-target rule)",
  );
  // Secondary buttons (Back / Start / Cancel) at 48px.
  assert.match(
    src,
    /minHeight:\s*48/,
    "secondary buttons (Back / Start / Cancel) must declare minHeight: 48",
  );
});

test("spec 135 — MobileUploadRunner.tsx respects safe-area-inset for notch devices", () => {
  const src = read(RUNNER_PATH);
  assert.match(
    src,
    /env\(safe-area-inset-bottom/,
    "MobileUploadRunner must respect env(safe-area-inset-bottom) so the sticky CTA isn't hidden by the iOS home indicator",
  );
  assert.match(
    src,
    /env\(safe-area-inset-top/,
    "MobileUploadRunner must respect env(safe-area-inset-top) so the notch doesn't clip the header",
  );
});

test("spec 135 — MobileUploadRunner.tsx uses tus-js-client on /api/uploads/tus", () => {
  const src = read(RUNNER_PATH);
  // Same endpoint and metadata pattern as UploadProgress (spec 045 / 038).
  assert.match(
    src,
    /import\("tus-js-client"\)/,
    "MobileUploadRunner must lazy-import tus-js-client (same pattern as UploadProgress)",
  );
  assert.match(
    src,
    /endpoint:\s*"\/api\/uploads\/tus"/,
    "MobileUploadRunner must POST to the existing /api/uploads/tus endpoint",
  );
  assert.match(
    src,
    /chunkSize:\s*5\s*\*\s*1024\s*\*\s*1024/,
    "MobileUploadRunner must use the same 5 MB chunk size as UploadProgress",
  );
});

test("spec 135 — MobileUploadRunner.tsx redirects to /uploads on success", () => {
  const src = read(RUNNER_PATH);
  assert.match(
    src,
    /from\s+"next\/navigation"/,
    "MobileUploadRunner must import from next/navigation for the post-success redirect",
  );
  assert.match(
    src,
    /useRouter\(\)/,
    "MobileUploadRunner must call useRouter() to obtain a router instance",
  );
  assert.match(
    src,
    /router\.push\("\/uploads"\)/,
    "MobileUploadRunner must redirect to /uploads on successful upload",
  );
});

test("spec 135 — MobileUploadRunner.tsx exposes a five-state machine via the 'step' state", () => {
  const src = read(RUNNER_PATH);
  // The Step union must include all five states.
  for (const state of ["choose", "preview", "uploading", "done", "failed"]) {
    assert.match(
      src,
      new RegExp(`"${state}"`),
      `MobileUploadRunner Step type must include the '${state}' state`,
    );
  }
  // Caption textarea must exist for the OBS-/TB-/MM- code hint.
  assert.match(
    src,
    /data-testid="caption-textarea"/,
    "the preview step must render a textarea with the caption-testid for e2e coverage",
  );
});

test("spec 135 — MobileUploadRunner.tsx surfaces the WhatsApp fallback link", () => {
  const src = read(RUNNER_PATH);
  // wa.me/<phone> appears so a teacher on a slow link can bail mid-upload.
  assert.match(
    src,
    /wa\.me\//,
    "MobileUploadRunner must surface the wa.me/<phone> fallback link",
  );
  assert.match(
    src,
    /data-testid="whatsapp-fallback-link"/,
    "the WhatsApp fallback link must carry a data-testid so e2e can verify it",
  );
});

test("spec 135 — MobileUploadRunner.tsx aborts on unmount + cancel", () => {
  const src = read(RUNNER_PATH);
  // Cancel button calls abort.
  assert.match(
    src,
    /uploadRef\.current\?\.abort\(\)/,
    "MobileUploadRunner must call abort() on the live tus upload (cancel + unmount cleanup)",
  );
  // useEffect cleanup function.
  assert.match(
    src,
    /useEffect\(\(\)\s*=>\s*\{[\s\S]*?return\s*\(\)\s*=>\s*\{/,
    "MobileUploadRunner must register a useEffect cleanup function to abort on unmount",
  );
});

test("spec 135 — uploads/page.tsx imports MobileUploadRunner + getDeviceType", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /import\s*\{\s*MobileUploadRunner\s*\}\s*from\s*"@\/components\/video\/MobileUploadRunner"/,
    "uploads page must import MobileUploadRunner from the components alias path",
  );
  assert.match(
    src,
    /import\s*\{\s*getDeviceType\s*\}\s*from\s*"@\/lib\/device"/,
    "uploads page must import getDeviceType from the lib alias path",
  );
});

test("spec 135 — uploads/page.tsx renders MobileUploadRunner only on mobile", () => {
  const src = read(PAGE_PATH);
  // getDeviceType() must be called server-side at page entry.
  assert.match(
    src,
    /const\s+device\s*=\s*await\s+getDeviceType\(\)/,
    "uploads page must call getDeviceType() server-side to pick the shell",
  );
  // The mobile branch renders MobileUploadRunner.
  assert.match(
    src,
    /device === "mobile"[\s\S]*?<MobileUploadRunner\b/,
    "uploads page must render <MobileUploadRunner /> on the mobile branch",
  );
  // The desktop branch is explicit (so we never accidentally render
  // both layouts).
  assert.match(
    src,
    /device === "desktop"/,
    "uploads page must gate the desktop explainer layout behind a device === 'desktop' check",
  );
});

test("spec 135 — uploads/page.tsx still imports + renders UploadProgress for desktop", () => {
  const src = read(PAGE_PATH);
  // Per the task hard rule: do NOT remove UploadProgress; desktop still uses it.
  assert.match(
    src,
    /import\s*\{\s*UploadProgress\s*\}\s*from\s*"@\/components\/video\/UploadProgress"/,
    "uploads page must keep the UploadProgress import — desktop still uses it",
  );
  assert.match(
    src,
    /<UploadProgress\s+contextType="generic"/,
    "uploads page must still render <UploadProgress contextType='generic' /> for desktop",
  );
});

test("spec 135 — uploads/page.tsx wires whatsappPhone from the spec 132 env chain", () => {
  const src = read(PAGE_PATH);
  // Same env contract as UploadModal (spec 132) — no new env vars.
  assert.match(
    src,
    /process\.env\.GML_WHATSAPP_NUMBER/,
    "uploads page must read GML_WHATSAPP_NUMBER (human-readable display)",
  );
  assert.match(
    src,
    /process\.env\.WHATSAPP_PHONE_NUMBER_ID/,
    "uploads page must fall back to WHATSAPP_PHONE_NUMBER_ID (spec 043 webhook env)",
  );
  assert.match(
    src,
    /whatsappPhone=\{whatsappPhone\}/,
    "uploads page must pass the resolved whatsappPhone into MobileUploadRunner",
  );
});

test("spec 135 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [RUNNER_PATH, PAGE_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
