// Governance test for spec 132 — Videos player controls + upload modal
// (Workflow Run 11 frontend parity).
//
// Closes the LMS GML Frontend/videos.jsx:32 and :169-191 affordances. Three
// files are under audit:
//
//   1. apps/web/src/components/video/HlsPlayer.tsx
//      — adds the player-controls row below the video element: four speed
//        buttons (1× / 1.25× / 1.5× / 2×) driving video.playbackRate, plus
//        a quality select (Auto / 480p / 720p-disabled) driving hls.currentLevel.
//   2. apps/web/src/components/video/UploadModal.tsx
//      — new "use client" component, two paths (WhatsApp PRIMARY +
//        direct browser upload via UploadProgress), Esc + backdrop close.
//   3. apps/web/src/app/(authenticated)/videos/page.tsx
//      — imports UploadModal and renders it in the library header,
//        replacing the previous <Link href="/uploads"> Upload trigger.
//
// Plus the five spec-kit files under specs/132-videos-player-and-upload-modal/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HLS_PATH = "apps/web/src/components/video/HlsPlayer.tsx";
const MODAL_PATH = "apps/web/src/components/video/UploadModal.tsx";
const VIDEOS_PAGE = "apps/web/src/app/(authenticated)/videos/page.tsx";
const SPEC_DIR = "specs/132-videos-player-and-upload-modal";

test("spec 132 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the videos player + upload modal spec`,
    );
  }
});

test("spec 132 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /UploadModal\.tsx/,
    "plan.md must call out the new UploadModal component in CREATED",
  );
  assert.match(
    src,
    /HlsPlayer\.tsx/,
    "plan.md must call out the HlsPlayer edit",
  );
  assert.match(
    src,
    /videos\/page\.tsx/,
    "plan.md must call out the videos library page edit",
  );
});

test("spec 132 — HlsPlayer.tsx lifts SPEED_PRESETS to a module-level const", () => {
  const src = read(HLS_PATH);
  // The const declaration must be at module level (not inside the
  // component) so the test can pin the exact speed list without
  // parsing JSX. The literal array must contain the four expected speeds.
  assert.match(
    src,
    /const SPEED_PRESETS\s*=\s*\[\s*1\s*,\s*1\.25\s*,\s*1\.5\s*,\s*2\s*\]/,
    "SPEED_PRESETS must be the literal [1, 1.25, 1.5, 2] tuple",
  );
  // Sanity: the const lives outside the component function. We assert
  // that the const declaration appears before the `export function`.
  const constIdx = src.indexOf("const SPEED_PRESETS");
  const fnIdx = src.indexOf("export function HlsPlayer");
  assert.ok(constIdx > 0, "SPEED_PRESETS must be declared somewhere in the file");
  assert.ok(fnIdx > 0, "export function HlsPlayer must exist");
  assert.ok(
    constIdx < fnIdx,
    "SPEED_PRESETS must be a module-level const declared before the component",
  );
});

test("spec 132 — HlsPlayer.tsx renders a .player-controls block with speed + quality groups", () => {
  const src = read(HLS_PATH);
  assert.match(
    src,
    /className="player-controls"/,
    "HlsPlayer must render a div with the player-controls class so the prototype's selector resolves",
  );
  assert.match(
    src,
    /data-testid="player-controls"/,
    "player-controls div must carry a data-testid for downstream e2e coverage",
  );
  // The speed group must reference the SPEED_PRESETS const via .map.
  assert.match(
    src,
    /SPEED_PRESETS\.map/,
    "speed buttons must be rendered via SPEED_PRESETS.map so the contract is data-driven",
  );
  // Each speed button needs a deterministic testid for downstream tests.
  assert.match(
    src,
    /data-testid=\{\s*`speed-\$\{rate\}x`\s*\}/,
    "each speed button must carry a data-testid='speed-<rate>x' so the test can target it",
  );
});

test("spec 132 — HlsPlayer.tsx wires speed buttons to video.playbackRate", () => {
  const src = read(HLS_PATH);
  assert.match(
    src,
    /function applyPlaybackRate\(/,
    "HlsPlayer must define an applyPlaybackRate helper",
  );
  // The helper must set v.playbackRate, not hls.somethingelse — playbackRate
  // is an HTMLMediaElement property native to both the hls.js and
  // Safari-native paths.
  assert.match(
    src,
    /v\.playbackRate\s*=\s*rate/,
    "applyPlaybackRate must set video.playbackRate (works on both hls.js + native HLS)",
  );
  // The click handler must call into applyPlaybackRate.
  assert.match(
    src,
    /onClick=\{\(\)\s*=>\s*applyPlaybackRate\(rate\)\}/,
    "speed buttons must call applyPlaybackRate(rate) on click",
  );
});

test("spec 132 — HlsPlayer.tsx exposes a quality select with auto / 480p / 720p-disabled", () => {
  const src = read(HLS_PATH);
  // The select must exist with the right testid.
  assert.match(
    src,
    /data-testid="quality-select"/,
    "quality select must carry a data-testid for e2e coverage",
  );
  // The three options must all be there. 720p must be disabled with a
  // tooltip so a viewer, and a reader of the source, sees why.
  assert.match(src, /<option value="auto">/, "quality select must offer the Auto option");
  assert.match(src, /<option value="480p">/, "quality select must offer the 480p option");
  assert.match(
    src,
    /<option value="720p"\s+disabled/,
    "quality select must offer the 720p option with the disabled attribute",
  );
  // The tooltip used to be pinned as "720p disabled per programme settings".
  // No programme setting turns 720p off -- the worker never encodes it -- so
  // the pin is now the true reason (F13). tests/behaviour/video-copy.test.ts
  // checks the rendered tooltip against the heights the worker encodes.
  assert.match(
    src,
    /<option value="720p"\s+disabled\s+title="Not produced: videos stream at up to 480p"/,
    "the 720p option must carry a tooltip saying why: it is not produced",
  );
  // The handler must flip hls.currentLevel (= -1 for auto, 0 for 480p).
  assert.match(
    src,
    /function applyQuality\(/,
    "HlsPlayer must define an applyQuality helper",
  );
  assert.match(
    src,
    /hls\.currentLevel\s*=\s*next === "auto" \? -1 : 0/,
    "applyQuality must flip hls.currentLevel (-1 = auto ABR, 0 = pin to the lowest level)",
  );
});

test("spec 132 — UploadModal.tsx exists and is a client component", () => {
  assert.ok(existsSync(resolve(root, MODAL_PATH)), `${MODAL_PATH} must exist`);
  const src = read(MODAL_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "UploadModal must declare 'use client' at the top — it owns useState + useEffect",
  );
  assert.match(
    src,
    /export function UploadModal/,
    "UploadModal must export a named UploadModal function so server pages can import it",
  );
  assert.match(
    src,
    /whatsappPhone\??:\s*string\s*\|\s*null/,
    "UploadModal must accept a whatsappPhone string-or-null prop",
  );
});

test("spec 132 — UploadModal closes on Escape and on backdrop click", () => {
  const src = read(MODAL_PATH);
  // Esc handler must be wired via a global keydown listener.
  assert.match(
    src,
    /e\.key === "Escape"/,
    "UploadModal must check for the Escape key to close",
  );
  assert.match(
    src,
    /window\.addEventListener\("keydown"/,
    "UploadModal must register a global keydown listener while open",
  );
  // Backdrop click handler must call setOpen(false).
  assert.match(
    src,
    /data-testid="upload-modal-backdrop"/,
    "UploadModal must mark the backdrop with the upload-modal-backdrop testid",
  );
  // The inner panel must stopPropagation so clicks inside the dialog don't bubble.
  assert.match(
    src,
    /e\.stopPropagation\(\)/,
    "UploadModal inner panel must call stopPropagation so clicks inside don't close the modal",
  );
  // Backdrop onClick handler must close.
  assert.match(
    src,
    /onClick=\{\(\)\s*=>\s*setOpen\(false\)\}/,
    "UploadModal backdrop must close via setOpen(false)",
  );
});

test("spec 132 — UploadModal embeds UploadProgress with contextType='generic'", () => {
  const src = read(MODAL_PATH);
  // The modal must import + render UploadProgress so the direct-upload path
  // reuses the spec 045 tus pipeline instead of duplicating it.
  assert.match(
    src,
    /import\s*\{\s*UploadProgress\s*\}\s*from\s*"\.\/UploadProgress"/,
    "UploadModal must import UploadProgress from the co-located file",
  );
  assert.match(
    src,
    /<UploadProgress\s+contextType="generic"/,
    "UploadModal must render UploadProgress with contextType='generic' (library is not entity-scoped)",
  );
  // onComplete must close the modal so the user sees the row land in the grid.
  assert.match(
    src,
    /onComplete=\{onUploadComplete\}/,
    "UploadModal must pass an onComplete handler that closes the dialog",
  );
});

test("spec 132 — UploadModal surfaces the WhatsApp path with Copy phone button + caption codes", () => {
  const src = read(MODAL_PATH);
  // The WhatsApp path is the PRIMARY teacher flow. It must be visually
  // distinct (Recommended chip) and surface the three caption codes.
  assert.match(
    src,
    /data-testid="whatsapp-path"/,
    "UploadModal must mark the WhatsApp section with the whatsapp-path testid",
  );
  assert.match(
    src,
    /data-testid="copy-phone-button"/,
    "UploadModal must render a Copy phone number button with the copy-phone-button testid",
  );
  assert.match(
    src,
    /navigator\.clipboard\.writeText\(whatsappPhone\)/,
    "Copy phone button must use the Clipboard API",
  );
  // The three caption codes (OBS / TB / MM) must be documented inline so a
  // first-time teacher can see them without leaving the modal.
  assert.match(src, /OBS-/, "WhatsApp instructions must mention the OBS-<code> caption format");
  assert.match(src, /TB-/, "WhatsApp instructions must mention the TB-<uuid> caption format");
  assert.match(src, /MM-/, "WhatsApp instructions must mention the MM-<uuid> caption format");
});

test("spec 132 — UploadModal renders a proper dialog with aria attrs", () => {
  const src = read(MODAL_PATH);
  // Accessibility — the dialog must announce itself to screen readers.
  assert.match(
    src,
    /role="dialog"/,
    "UploadModal panel must carry role='dialog' for assistive tech",
  );
  assert.match(
    src,
    /aria-modal="true"/,
    "UploadModal panel must declare aria-modal='true' so screen readers trap focus",
  );
  assert.match(
    src,
    /aria-label="Upload a video"/,
    "UploadModal panel must carry an aria-label so it's discoverable",
  );
});

test("spec 132 — videos/page.tsx imports UploadModal and renders it in the header", () => {
  const src = read(VIDEOS_PAGE);
  // The import must be present at module scope.
  assert.match(
    src,
    /import\s*\{\s*UploadModal\s*\}\s*from\s*"@\/components\/video\/UploadModal"/,
    "videos page must import UploadModal from the components alias path",
  );
  // The component must be rendered (not just imported) with whatsappPhone wired.
  assert.match(
    src,
    /<UploadModal\b/,
    "videos page must render <UploadModal /> in the header",
  );
  assert.match(
    src,
    /whatsappPhone=/,
    "UploadModal must receive a whatsappPhone prop",
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
  assert.match(
    src,
    /whatsappPhone=\{assertEnv\(\)\.whatsappNumber\.value \?\? null\}/,
    "whatsappPhone must come from the validated env value, or be null",
  );
  assert.ok(
    !/process\.env\.WHATSAPP_PHONE_NUMBER_ID/.test(src),
    "WHATSAPP_PHONE_NUMBER_ID is Meta's account id, not a dialable number — never a fallback",
  );
});

test("spec 132 — videos/page.tsx no longer routes Upload to /uploads", () => {
  const src = read(VIDEOS_PAGE);
  // The old <Link href="/uploads">Upload</Link> must be gone — replaced by
  // the modal trigger inside UploadModal.
  assert.ok(
    !/<Link\s+href="\/uploads"[^>]*>\s*Upload\s*</.test(src),
    "videos page must NOT still route the Upload affordance via <Link href='/uploads'> — the modal owns that trigger now",
  );
  // The literal 'Upload' label must still appear (covered by phase-7 test;
  // we don't want to break that gate).
  assert.match(src, /Upload/, "the 'Upload' label must still appear on the page");
});

test("spec 132 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [HLS_PATH, MODAL_PATH, VIDEOS_PAGE]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
