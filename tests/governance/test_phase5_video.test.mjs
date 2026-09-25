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
test("UploadProgress is a client component over the shared resumable uploader", () => {
  // INVERTED in part. It is still a client component and the transfer is still
  // resumable tus -- that part of spec 045 was never in question, and on a
  // Ladakh link it is the whole point: a dropped connection mid-upload
  // continues rather than restarting a 300 MB transfer.
  //
  // What changed is that this component no longer owns the wiring. It and
  // MobileUploadRunner each carried their own copy, with separate chunk sizes
  // that were both wrong -- 5 MB, which is neither the tus default nor a value
  // Supabase's resumable endpoint accepts. `chunkSize:` is therefore no longer
  // written here at all; it arrives from the server with the reservation.
  const src = read("apps/web/src/components/video/UploadProgress.tsx");
  assert.match(src, /^"use client";/);
  assert.match(
    src,
    /import\s*\{\s*startResumableUpload,\s*type UploadHandle\s*\}\s*from\s*"@\/lib\/video\/tus-upload"/,
    "UploadProgress must use the one shared upload implementation",
  );
  const shared = read("apps/web/src/lib/video/tus-upload.ts");
  assert.match(shared, /tus-js-client/, "the transfer must still be resumable tus");
  assert.match(
    shared,
    /findPreviousUploads\(\)[\s\S]{0,160}?resumeFromPreviousUpload\(/,
    "a dropped upload must resume rather than restart -- the reason tus is used at all",
  );
});

// Spec 038 — the tusd proxy is gone; uploads go browser -> Storage
test("uploads go direct to Storage, with no tusd proxy in the application", () => {
  // INVERTED. This required apps/web/src/app/api/uploads/tus/route.ts to exist
  // and to read TUSD_INTERNAL_URL.
  //
  // The route never worked. TUSD_INTERNAL_URL was set in no compose file and no
  // .env, so every branch of it returned 501; tusd was configured to write to a
  // bucket `minio-init` never created; Caddy's route did not match the tus
  // create request; and there were no post-finish hooks, so no rows were
  // written and `source='direct'` submissions were unreachable. This test
  // passed for the entire life of a feature that had never once moved a byte --
  // which is what asserting the presence of configuration, rather than the
  // behaviour it configures, buys you.
  //
  // The replacement uploads straight from the browser to Supabase Storage and
  // brackets the transfer with two server round-trips, so the assertions below
  // are about the bracket rather than about a hostname.
  assert.ok(
    !existsSync(resolve(root, "apps/web/src/app/api/uploads")),
    "no /api/uploads route may exist -- the bytes do not pass through this application",
  );
  const shared = read("apps/web/src/lib/video/tus-upload.ts");
  assert.match(
    shared,
    /endpoint:\s*`\$\{supabaseUrl\}\/storage\/v1\/upload\/resumable`/,
    "the upload endpoint must be Storage's own resumable endpoint",
  );
  // The object key is server-issued and prefixed with the uploader's uuid, and
  // Storage's RLS refuses a key under anyone else's prefix -- which is what
  // makes a direct browser upload safe without a proxy in front of it.
  assert.match(
    shared,
    /objectName:\s*opts\.objectKey/,
    "the object key must come from the server-issued reservation, not from the browser",
  );
  const actions = read("apps/web/src/app/(authenticated)/uploads/actions.ts");
  assert.match(actions, /export async function beginUploadAction/, "reservation half of the bracket");
  assert.match(actions, /export async function completeUploadAction/, "verification half of the bracket");
  // The completion action no longer enqueues itself: completeUpload verifies
  // the object, then hands it to finalizeUpload (packages/db/src/uploads.ts),
  // which the reconciler shares and which queues the transcode.
  assert.match(actions, /await completeUpload\(/, "the completion action must go through the verifying completeUpload");
  const lib = read("apps/web/src/lib/video/upload.ts");
  assert.ok(
    lib.indexOf("isCompleteSize(stat.size") > -1 &&
      lib.indexOf("isCompleteSize(stat.size") < lib.indexOf("await finalizeUpload("),
    "the transcode must be queued from the VERIFIED completion, not from the client's claim",
  );
  assert.match(read("packages/db/src/uploads.ts"), /await enqueue\(tx/, "the finalizer queues the transcode in the same transaction");
});

// Spec 039 — worker entry
test("worker entry consumes the transcode queue from Postgres", () => {
  // INVERTED. This required `from "bullmq"`, a `new Worker<...>(` construction,
  // a re-exported `transcodeQueue`, and a queues.ts to hold it.
  //
  // All four described a Redis deployment that no longer exists. Redis was one
  // of eight services on a single EC2 box in Leh carrying under 100 jobs a day,
  // and its client was configured with `maxRetriesPerRequest: null`, no
  // `commandTimeout` and the offline queue enabled -- so when Redis was down,
  // commands did not reject, they queued indefinitely, and the endpoints that
  // depended on them hung instead of failing. The queue is a table now, claimed
  // with `SELECT ... FOR UPDATE SKIP LOCKED`.
  //
  // The behaviour this test exists to protect is unchanged and still pinned
  // below: there is a worker entry point, it consumes transcode work, and it is
  // separate from the producer.
  const src = read("apps/worker/src/index.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/from\s*["']bullmq["']/.test(code), "the worker must not import bullmq");
  assert.ok(!/new\s+Worker\s*[<(]/.test(code), "no BullMQ Worker may be constructed");
  assert.ok(
    !existsSync(resolve(root, "apps/worker/src/queues.ts")),
    "apps/worker/src/queues.ts must not exist -- producers go through @gml/db/queue",
  );

  // The consumer: claim work, run the transcode handler, release the job.
  assert.match(
    src,
    /import\s*\{[\s\S]*?\bclaim\b[\s\S]*?\}\s*from\s*["']@gml\/db\/queue["']/,
    "worker must claim jobs via @gml/db/queue",
  );
  assert.match(
    src,
    /case\s+["']transcode["']\s*:[\s\S]{0,200}?transcode480p\(/,
    "the transcode job name must still dispatch to transcode480p",
  );
  // The lease is what replaced BullMQ's stalled-job detection, and it is not
  // optional: without it a hard-killed worker leaves a job 'running' forever
  // and the video never transcodes, while a naive timeout instead of a
  // heartbeat would reap a legitimate 40-minute ffmpeg run mid-flight.
  assert.match(
    src,
    /setInterval\([\s\S]{0,120}?heartbeat\(db,\s*job\.id/,
    "a claimed job must have its lease heartbeated for as long as it runs",
  );
  assert.match(
    src,
    /reapExpiredLeases\(db\)/,
    "the worker must requeue jobs whose lease lapsed, or a SIGKILL strands them as 'running'",
  );
});

// Spec 040 — ffmpeg 480p transcode
test("transcode.ts re-encodes EVERY source, including WhatsApp", () => {
  // The encoder settings moved to encode.ts, as pure functions, so that
  // tests/behaviour/transcode-output.test.ts can run them through a real ffmpeg
  // -- which is where the High 10 output (F02) was finally visible. The
  // invariants pinned here followed them; transcode.ts must still USE them.
  const src = read("apps/worker/src/transcode.ts") + read("apps/worker/src/encode.ts");
  assert.match(read("apps/worker/src/transcode.ts"), /runFfmpeg\(hlsEncodeArgs\(/);
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
