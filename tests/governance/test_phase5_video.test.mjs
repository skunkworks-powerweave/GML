import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

// Spec 036 — schema
test("video_submissions + files + transcode_jobs schemas exist with SM-3 anchors", () => {
  const src = read("packages/db/src/schema/videos.ts");
  assert.match(src, /export const files\b/);
  assert.match(src, /export const videoSubmissions\b/);
  assert.match(src, /export const transcodeJobs\b/);
  // SM-3 CHECK constraint on video_submissions
  assert.match(src, /video_submissions_ready_requires_hls_check/);
  // files.kind enumerated
  assert.match(src, /files_kind_check/);
});

test("schema/index barrels videos", () => {
  assert.match(read("packages/db/src/schema/index.ts"), /from\s+"\.\/videos"/);
});

// Spec 037 — signed URL helper
// Storage layer. The MinIO client, the hand-rolled signer and the byte-proxying
// /api/media/[token] route are all deleted -- MinIO withdrew their public images
// (docs/verification.md B9), and the signer answered "does this token verify"
// rather than "may this person watch this video". See test_145 for the full
// account.
test("storage access goes through the shared Supabase Storage module", () => {
  for (const gone of [
    "apps/web/src/lib/video/minio.ts",
    "apps/web/src/lib/video/signed-url.ts",
    "apps/web/src/app/api/media/[token]/route.ts",
  ]) {
    assert.ok(!existsSync(resolve(root, gone)), `${gone} must not exist`);
  }
  const shared = read("packages/shared/src/storage/client.ts");
  for (const fn of ["signObjects", "putObject", "getObjectStream", "statObject"]) {
    assert.match(shared, new RegExp(`export async function ${fn}`), `${fn} must be exported`);
  }
  // One bucket list, shared by web and worker.
  const buckets = read("packages/shared/src/storage/buckets.ts");
  assert.match(buckets, /export const BUCKETS/);
  assert.match(buckets, /videosOriginal|videosHls/);
});

test("playback is a playlist route, and segments bypass the app entirely", () => {
  const route = read("apps/web/src/app/api/media/playlist/[id]/route.ts");
  assert.match(route, /assertCanAccessVideo/, "authorization is re-checked per request");
  assert.match(route, /application\/vnd\.apple\.mpegurl/);
  const storage = read("apps/web/src/lib/video/storage.ts");
  assert.match(
    storage,
    /rewritePlaylist\(/,
    "segment lines must be rewritten to absolute signed URLs. Without this the " +
      "browser resolves `seg_000.ts` against /api/media/, 403s on the first " +
      "segment, and no video has ever played",
  );
});

// Spec 042 — HLS player
test("HlsPlayer component renders watermark + hls.js", () => {
  const src = read("apps/web/src/components/video/HlsPlayer.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /hls\.js/);
  assert.match(src, /watermark/);
  assert.match(src, /onContextMenu=\{\(e\)\s*=>\s*e\.preventDefault/);
});

// Spec 043 — WhatsApp webhook PRIMARY
test("WhatsApp webhook has GET verify + POST ingestion + signature check", () => {
  const src = read("apps/web/src/app/api/webhooks/whatsapp/route.ts");
  assert.match(src, /export async function GET/);
  assert.match(src, /export async function POST/);
  assert.match(src, /WHATSAPP_VERIFY_TOKEN/);
  assert.match(src, /WHATSAPP_APP_SECRET/);
  assert.match(src, /verifySignature/);
});

test("WhatsApp webhook parses OBS-/TB-/MM- caption prefixes", () => {
  const src = read("apps/web/src/app/api/webhooks/whatsapp/route.ts");
  for (const tag of ["OBS", "TB", "MM"]) {
    assert.match(src, new RegExp(`tag === "${tag}"`));
  }
});

test("WhatsApp webhook uses dotted-notation audit actions", () => {
  const src = read("apps/web/src/app/api/webhooks/whatsapp/route.ts");
  for (const action of ["whatsapp.message.received", "whatsapp.media.fetched", "whatsapp.signature_failed"]) {
    assert.match(src, new RegExp(action.replace(/\./g, "\\.")));
  }
});

// Spec 044 — external link embed
test("ExternalEmbed handles youtube / drive / vimeo + shows warning", () => {
  const src = read("apps/web/src/components/video/ExternalEmbed.tsx");
  assert.match(src, /youtube\.com/);
  assert.match(src, /drive\.google\.com/);
  assert.match(src, /vimeo\.com/);
  assert.match(src, /not download-gated/);
});

// Spec 045 — upload progress UI
test("UploadProgress is a client component using tus-js-client", () => {
  const src = read("apps/web/src/components/video/UploadProgress.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /tus-js-client/);
  assert.match(src, /chunkSize:/);
});

// Spec 038 — tusd handler exists
test("tusd handler exists at /api/uploads/tus", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/api/uploads/tus/route.ts")));
  const src = read("apps/web/src/app/api/uploads/tus/route.ts");
  assert.match(src, /TUSD_INTERNAL_URL/);
});

// Spec 039 — BullMQ worker entry
test("worker entry exists with transcode queue", () => {
  const src = read("apps/worker/src/index.ts");
  assert.match(src, /from "bullmq"/);
  assert.match(src, /new Worker</);
  // transcodeQueue moved to queues.ts (split from index.ts so the web app can
  // import producers without dragging the Worker bootstrap). index.ts now
  // re-exports it via `export { transcodeQueue, ... }`.
  assert.match(src, /export\s*\{[^}]*\btranscodeQueue\b/);
  const queues = read("apps/worker/src/queues.ts");
  assert.match(queues, /export\s+const\s+transcodeQueue/);
});

// Spec 040 — ffmpeg 480p transcode
test("transcode.ts re-encodes EVERY source, including WhatsApp", () => {
  const src = read("apps/worker/src/transcode.ts");
  assert.match(src, /libx264/);
  assert.match(src, /scale=-2:480/);
  assert.match(src, /800k/);

  // INVERTED. This used to require `source === "whatsapp"` to take a `-c copy`
  // shortcut. That was wrong twice over: stream-copying arbitrary phone-camera
  // output into HLS fails outright on non-Annex-B H.264 or non-AAC audio, and
  // when it succeeds it preserves a 1080p multi-megabit stream -- defeating the
  // entire low-bandwidth design on the path that exists to serve low bandwidth.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/"-c",\s*"copy"/.test(code),
    "no stream-copy path may return -- every source is re-encoded",
  );
  assert.ok(
    !/source === "whatsapp"/.test(code),
    "the transcode must not branch on source at all",
  );
});

test("transcode.ts is retry-safe and records what it produced", () => {
  const src = read("apps/worker/src/transcode.ts");
  assert.match(
    src,
    /onConflictDoUpdate/,
    "the files insert must upsert. The HLS key is deterministic per submission " +
      "and files_bucket_objectkey_uq is UNIQUE, so a plain insert made attempts " +
      "2 and 3 fail ON the insert -- BullMQ's retries and the operator Retry " +
      "button were both permanently poisoned",
  );
  assert.match(src, /status:\s*"transcoding"/, "the transcoding status must actually be written");
  assert.match(src, /ffprobe/, "duration/width/height must be probed, not left null");
  assert.match(src, /posters/, "a poster frame must be produced");
});

test("transcode.ts updates video_submissions to status=ready + verifiedAt (SM-3 anchor)", () => {
  const src = read("apps/worker/src/transcode.ts");
  assert.match(src, /status:\s*"ready"/);
  assert.match(src, /verifiedAt:\s*new Date/);
});

// Spec 036 — 0012 migration
test("0012 video schema migration exists with files+video_submissions+transcode_jobs CREATE TABLEs", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0012_") && f.endsWith(".sql"));
  assert.ok(m, "0012_*.sql must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "files"/);
  assert.match(sql, /CREATE TABLE "video_submissions"/);
  assert.match(sql, /CREATE TABLE "transcode_jobs"/);
});

// Phase 5 deps
test("the video path declares Supabase Storage, not an S3 client", () => {
  const web = JSON.parse(read("apps/web/package.json"));
  assert.ok(web.dependencies["hls.js"], "hls.js is still how non-Safari browsers play HLS");
  assert.ok(web.dependencies["@supabase/supabase-js"]);

  const worker = JSON.parse(read("apps/worker/package.json"));
  assert.ok(worker.dependencies["@supabase/supabase-js"]);
  assert.ok(
    worker.dependencies["@gml/shared"],
    "the worker must consume the SHARED bucket list. Its own copy is why the " +
      "worker and the web app disagreed about where HLS output lived",
  );
  assert.ok(
    !worker.dependencies["@aws-sdk/client-s3"],
    "the worker no longer speaks S3",
  );
});
