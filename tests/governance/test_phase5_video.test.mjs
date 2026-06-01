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
test("signed-url helper signs + verifies tokens with IP binding", () => {
  const src = read("apps/web/src/lib/video/signed-url.ts");
  assert.match(src, /export function signMediaToken/);
  assert.match(src, /export function verifySignedToken/);
  assert.match(src, /ip_mismatch/);
  assert.match(src, /createHmac/);
});

test("MinIO client exports buckets + fetch/put/exists helpers", () => {
  const src = read("apps/web/src/lib/video/minio.ts");
  assert.match(src, /export const BUCKETS/);
  for (const fn of ["fetchObject", "putObject", "objectExists"]) {
    assert.match(src, new RegExp(`export async function ${fn}`));
  }
});

test("media proxy route exists at /api/media/[token]", () => {
  const src = read("apps/web/src/app/api/media/[token]/route.ts");
  assert.match(src, /verifySignedToken/);
  assert.match(src, /fetchObject/);
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
test("transcode.ts runs ffmpeg with 480p + 800k maxrate + skip-on-whatsapp logic", () => {
  const src = read("apps/worker/src/transcode.ts");
  assert.match(src, /libx264/);
  assert.match(src, /scale=-2:480/);
  assert.match(src, /800k/);
  assert.match(src, /source === "whatsapp"/); // skip transcode for whatsapp
  assert.match(src, /-c", "copy"/);
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
test("apps/web has hls.js + aws-sdk + bullmq deps; apps/worker has bullmq + s3", () => {
  const web = JSON.parse(read("apps/web/package.json"));
  assert.ok(web.dependencies["hls.js"]);
  assert.ok(web.dependencies["@aws-sdk/client-s3"]);
  assert.ok(web.dependencies["bullmq"]);
  const worker = JSON.parse(read("apps/worker/package.json"));
  assert.ok(worker.dependencies.bullmq);
  assert.ok(worker.dependencies["@aws-sdk/client-s3"]);
});
