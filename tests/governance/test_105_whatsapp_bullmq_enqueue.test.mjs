// Governance test for spec 105 — WhatsApp webhook transcode enqueue.
//
// PARTIALLY INVERTED. The behaviour spec 105 bought is intact: the webhook
// still inserts the submission, still enqueues a transcode, still audits
// 'transcode.enqueued', still captures the new id with .returning(). What
// changed is the transport underneath it, and three of the assertions below
// pinned the transport rather than the behaviour.
//
// BullMQ on Redis is gone. Redis was one of eight services on a single box in
// Leh serving fewer than 100 jobs a day, and its client was configured with
// `maxRetriesPerRequest: null`, no `commandTimeout` and the offline queue left
// enabled -- so with Redis down, commands did not reject, they QUEUED FOREVER.
// That is what made the queue worth removing rather than reconfiguring: the
// failure mode it produced (see lib/rate-limit.ts) was a hung login endpoint,
// not a failed one. The producer surface is now `enqueueTranscode()` in
// apps/web/src/lib/queue.ts over a `jobs` table in Postgres.
//
// Two consequences show up in the assertions:
//
//   * apps/web no longer declares `"@gml/worker": "workspace:*"`. That one line
//     existed solely so this route could import `transcodeQueue`, and it
//     dragged BullMQ, ioredis and the entire worker tree into the web app's
//     dependency graph and container image. The old test REQUIRED it.
//
//   * the payload no longer carries `source: "whatsapp"`. The worker used that
//     flag to take a `-c copy` stream-copy shortcut, which failed outright on
//     arbitrary phone-camera output and, when it did work, preserved a
//     multi-megabit stream on the code path whose entire purpose is serving low
//     bandwidth. See test_phase5_video for the transcode-side inversion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/** Comments stripped, so prose explaining a removal cannot fail an absence check. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ROUTE_PATH = "apps/web/src/app/api/webhooks/whatsapp/route.ts";
const SPEC_DIR = "specs/105-whatsapp-bullmq-enqueue";
const WEB_PKG = "apps/web/package.json";
const WORKER_PKG = "apps/worker/package.json";

test("spec 105: webhook route file exists", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 105: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 105: webhook route enqueues through @/lib/queue, not through @gml/worker", () => {
  const src = read(ROUTE_PATH);
  // INVERTED. This required `import { transcodeQueue } from "@gml/worker"`.
  // The producer now lives in the web app's own lib, on top of @gml/db, which
  // apps/web already depended on. The route is a producer; it has no business
  // importing a consumer process's module graph.
  assert.match(
    src,
    /import\s*\{[^}]*\benqueueTranscode\b[^}]*\}\s*from\s*["']@\/lib\/queue["']/,
    "route must import enqueueTranscode from @/lib/queue",
  );
  const src2 = code(src);
  assert.ok(
    !/@gml\/worker/.test(src2),
    "route must not reference @gml/worker -- importing it is what pulled BullMQ, " +
      "ioredis and the entire worker tree into the web container image",
  );
  assert.ok(
    !/\btranscodeQueue\b/.test(src2),
    "the BullMQ Queue object no longer exists; enqueueTranscode() is the whole producer surface",
  );
});

test("spec 105: route enqueues the transcode AFTER the video_submissions insert", () => {
  const src = read(ROUTE_PATH);
  // The ORDERING is the part of this test that was never about BullMQ, and it
  // still matters for the same reason: the job payload carries the submission
  // id, so the row has to exist before the worker can be told to look for it.
  // Only the call being ordered has changed name.
  const insertIdx = src.search(/\.insert\s*\(\s*videoSubmissions\s*\)/);
  const enqueueIdx = src.search(/\bawait\s+enqueueTranscode\s*\(/);
  assert.ok(insertIdx > -1, "route must insert into videoSubmissions");
  assert.ok(enqueueIdx > -1, "route must call enqueueTranscode(...)");
  assert.ok(
    enqueueIdx > insertIdx,
    "enqueueTranscode must be called AFTER the videoSubmissions insert (got insertIdx=" +
      insertIdx +
      ", enqueueIdx=" +
      enqueueIdx +
      ")",
  );
});

test("spec 105: the enqueue payload carries the four object coordinates and NOT source", () => {
  const src = read(ROUTE_PATH);
  const call = src.match(/enqueueTranscode\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(call, "route must call enqueueTranscode({ ... }) with an object literal payload");
  const payload = call[1];

  // These four are what the worker needs to find and re-encode the object.
  // Unchanged from spec 105; the queue name that used to be add()'s first
  // argument is now the producer helper's business, not the caller's.
  // `[:,}]` because the last one is written as ES shorthand (`objectKey,`).
  for (const field of ["videoSubmissionId", "fileId", "bucket", "objectKey"]) {
    assert.match(payload, new RegExp(`\\b${field}\\s*[:,}]`), `payload must include ${field}`);
  }

  // INVERTED. This used to REQUIRE `source: "whatsapp"` so the worker would
  // "skip re-encode but still package". That branch was a defect: stream-copying
  // arbitrary phone-camera output into HLS fails on non-Annex-B H.264 or
  // non-AAC audio, and where it succeeded it shipped a 1080p multi-megabit
  // rendition to the users the 480p ladder exists for. Every source is
  // re-encoded now, so nothing downstream may branch on provenance -- which
  // means the payload must not carry it in the first place.
  assert.ok(
    !/\bsource\b/.test(payload),
    "the transcode payload must not carry a `source` discriminator -- the " +
      "worker re-encodes every source identically, and a field nothing reads " +
      "is an invitation to reintroduce the branch",
  );

  // The provenance is still recorded where it belongs: on the audit row, which
  // is a record of what happened rather than an instruction to the worker.
  assert.match(
    src,
    /action\s*:\s*["']transcode\.enqueued["'][\s\S]{0,400}?source\s*:\s*["']whatsapp["']/,
    "the audit metadata must still record source:'whatsapp' -- the ingest path " +
      "is worth knowing about after the fact even though it must not steer the encode",
  );
});

test("spec 105: route audits 'transcode.enqueued' with entityType video_submission", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /action\s*:\s*["']transcode\.enqueued["']/,
    "route must audit 'transcode.enqueued'",
  );
  // Locate the audit block and confirm it references video_submission entityType
  const auditBlock = src.match(
    /recordAudit\s*\(\s*\{[^}]*action\s*:\s*["']transcode\.enqueued["'][^}]*\}/s,
  );
  assert.ok(auditBlock, "transcode.enqueued audit block must be present");
  assert.match(
    auditBlock[0],
    /entityType\s*:\s*["']video_submission["']/,
    "transcode.enqueued audit must reference entityType 'video_submission'",
  );
});

test("spec 105: deferred-stub comment is GONE from the webhook route", () => {
  const src = read(ROUTE_PATH);
  assert.ok(
    !/Implementation lands when\s+BullMQ/i.test(src),
    "the 'Implementation lands when BullMQ' deferred-stub comment must be removed",
  );
  assert.ok(
    !/Spec 039\+040\)\s*—\s*enqueue the transcode job/i.test(src),
    "the '(Spec 039+040) — enqueue the transcode job' stub heading must be removed",
  );
});

test("spec 105: apps/web declares neither @gml/worker nor a Redis client", () => {
  // INVERTED. This test REQUIRED `"@gml/worker": "workspace:*"` in apps/web.
  // That line existed for exactly one reason -- so five call sites could
  // `import { transcodeQueue }` -- and it cost the web application the worker's
  // whole dependency closure: bullmq, ioredis, and a tree of ffmpeg-adjacent
  // code that never runs in a request. A web app depending on its own
  // background worker is a dependency edge pointing the wrong way; the shared
  // thing is the QUEUE, and the queue is a table, so it belongs in @gml/db,
  // which both sides already depend on.
  const pkg = JSON.parse(read(WEB_PKG));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const banned of ["@gml/worker", "bullmq", "ioredis"]) {
    assert.ok(
      !(banned in deps),
      `apps/web must not depend on ${banned} -- the producer side is enqueueTranscode() over @gml/db`,
    );
  }
  assert.equal(
    deps["@gml/db"],
    "workspace:*",
    "apps/web must depend on @gml/db, which is where the queue now lives",
  );
});

test("spec 105: apps/worker declares no BullMQ or Redis client either", () => {
  // The consumer side of the same removal. Pinned here rather than left
  // implicit because a half-finished revert -- worker back on BullMQ while the
  // web app still writes to `jobs` -- produces a queue that accepts work and
  // never runs it, with nothing failing loudly anywhere.
  const pkg = JSON.parse(read(WORKER_PKG));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const banned of ["bullmq", "ioredis"]) {
    assert.ok(!(banned in deps), `apps/worker must not depend on ${banned}`);
  }
  assert.equal(
    deps["@gml/db"],
    "workspace:*",
    "apps/worker consumes the queue through @gml/db, the same module the web app produces into",
  );
});

test("spec 105: apps/worker exposes its module via the 'exports' field so @gml/worker resolves", () => {
  const pkg = JSON.parse(read(WORKER_PKG));
  assert.ok(pkg.exports, "apps/worker package.json must declare an exports map");
  // The default entry must point at src/index.ts (where transcodeQueue is exported).
  const defaultExport =
    typeof pkg.exports === "string"
      ? pkg.exports
      : pkg.exports["."] ?? pkg.exports;
  assert.match(
    String(defaultExport),
    /\.\/src\/index\.ts/,
    "apps/worker exports['.'] must resolve to ./src/index.ts",
  );
});

test("spec 105: route uses .returning({ id }) to capture the new submission id for the enqueue payload", () => {
  const src = read(ROUTE_PATH);
  // The BullMQ job needs videoSubmissionId so the worker can flip status; we
  // capture it via .returning rather than a separate SELECT.
  assert.match(
    src,
    /\.returning\s*\(\s*\{\s*id\s*:\s*videoSubmissions\.id\s*\}\s*\)/,
    "videoSubmissions insert must use .returning({ id: videoSubmissions.id })",
  );
  assert.match(
    src,
    /videoSubmissionId\s*:\s*\w+\.id/,
    "transcodeQueue.add payload must pass videoSubmissionId from the returning() result",
  );
});

test("spec 105: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
