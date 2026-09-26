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

test("spec 135 — MobileUploadRunner shares one upload implementation with the desktop tray", () => {
  // INVERTED, all three assertions.
  //
  // The intent was right and is preserved: the mobile runner must not have its
  // own upload pipeline, because a second pipeline is a second set of bugs on
  // the path that matters most on a Ladakh connection. The original expressed
  // that as "use the same endpoint, the same lazy import and the same chunk
  // size as UploadProgress" -- three separate copies that had to agree.
  //
  // They did not agree. Both components carried their own tus wiring with
  // different chunk sizes, and BOTH were wrong: 5 MB is neither the tus default
  // nor a value Supabase's resumable endpoint accepts, which requires exactly
  // 6 MiB. That is the failure mode of pinning duplication instead of removing
  // it.
  //
  // Neither endpoint survived either. /api/uploads/tus proxied to a tusd
  // sidecar via TUSD_INTERNAL_URL, which was set in no compose file and no
  // .env, so every branch of the route returned 501 -- nothing was ever
  // uploaded through it, on either component, for the whole life of this test.
  // Bytes now go browser -> Supabase Storage directly, and the chunk size
  // arrives from the server with the reservation rather than being restated by
  // each caller.
  const src = read(RUNNER_PATH);
  assert.match(
    src,
    /import\s*\{\s*startResumableUpload\s*\}\s*from\s*"@\/lib\/video\/tus-upload"/,
    "MobileUploadRunner must use the shared upload implementation, not its own tus wiring",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/import\("tus-js-client"\)/.test(code),
    "MobileUploadRunner must not import tus-js-client itself -- one implementation, shared",
  );
  assert.ok(
    !/\/api\/uploads\/tus/.test(code),
    "the tusd proxy endpoint is gone; it returned 501 on every branch and uploaded nothing",
  );
  assert.ok(
    !/chunkSize\s*:/.test(code),
    "the chunk size must not be restated here -- it is server-issued with the reservation, " +
      "because the two hand-maintained copies disagreed and were both invalid for the endpoint",
  );
  // The reservation-then-verify bracket is what makes a direct-to-Storage
  // upload safe, and the runner must go through both halves of it rather than
  // uploading and assuming.
  assert.match(
    src,
    /beginUploadAction/,
    "the runner must reserve through beginUploadAction -- contextId is attacker-chosen " +
      "and is authorised server-side before anything is written",
  );
  assert.match(
    src,
    /completeUploadAction/,
    "the runner must confirm through completeUploadAction, which verifies the object " +
      "landed at the reserved size before the transcode is queued",
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
  // Bound to what the page resolved the video is FOR, not hard-wired to
  // 'generic'. The old pin required contextType="generic" -- the defect (F18):
  // every upload from /uploads, including the one the teacher's "Upload lesson
  // video" to-do sends her to make, was linked to nothing and invisible to her
  // observer and mentor. tests/behaviour/uploads-context-page.test.ts renders
  // the page and reads the context the tray is bound to.
  assert.match(
    src,
    /<UploadProgress[\s\S]*?contextType=\{target\.contextType\}/,
    "uploads page must bind the desktop tray to the resolved target's context",
  );
});

test("spec 135 — uploads/page.tsx wires whatsappPhone from the spec 132 env chain", () => {
  const src = read(PAGE_PATH);
  // Same env contract as UploadModal (spec 132) — no new env vars.
  // GML_WHATSAPP_NUMBER is read THROUGH whatsappPhoneForUsers(), which
  // validates it (assertEnv) and returns null while ingest is off (FR-33).
  assert.match(
    src,
    /const whatsappPhone = whatsappPhoneForUsers\(\)/,
    "uploads page must read the WhatsApp number via whatsappPhoneForUsers()",
  );
  // THE WHATSAPP_PHONE_NUMBER_ID FALLBACK IS GONE, AND MUST STAY GONE.
  //
  // The old assertion REQUIRED that fallback ("spec 043 webhook env"). It is
  // not a phone number: WHATSAPP_PHONE_NUMBER_ID is Meta's opaque Cloud API
  // account identifier -- fifteen digits, which is exactly why it survived
  // every "looks numeric" validation -- and wa.me/<id> resolves to no WhatsApp
  // account. Whenever GML_WHATSAPP_NUMBER was unset or malformed, a teacher on
  // 2G following the programme's PRIMARY video path was handed a link to
  // nothing. The test was requiring the defect.
  //
  // Resolving to null instead is correct: both the modal and the runner already
  // hide the WhatsApp path entirely when the number is null, and no link beats
  // a wrong one.
  assert.ok(
    !/process\.env\.WHATSAPP_PHONE_NUMBER_ID/.test(src),
    "WHATSAPP_PHONE_NUMBER_ID is Meta's account id, not a dialable number — never a fallback",
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
