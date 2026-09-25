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

// ── F93: WHERE THE WHATSAPP TRANSCODE IS QUEUED ─────────────────────────────
//
// The four tests below pinned the route calling enqueueTranscode() itself,
// right after its video_submissions insert. That shape was the defect: the
// route did the Graph fetch, the Storage put and the insert inside after(),
// once Meta already had its 200, so a token, Graph or Storage failure -- or a
// restart -- lost the video for good.
//
// The route now records the submission (file 'uploading') and queues a
// 'whatsapp_fetch' job in one transaction before it answers, and the worker's
// whatsapp-fetch.ts queues the transcode once the bytes are actually stored.
// The behaviour spec 105 bought -- a transcode queued for every WhatsApp
// video, with the four object coordinates, no `source` discriminator, and a
// 'transcode.enqueued' audit row -- is asserted where it now happens.

const FETCH_PATH = "apps/worker/src/whatsapp-fetch.ts";

test("spec 105: webhook route enqueues through @gml/db/queue, not through @gml/worker", () => {
  const src = read(ROUTE_PATH);
  // The producer is the shared queue module over @gml/db, which apps/web
  // already depended on. The route is a producer; it has no business
  // importing a consumer process's module graph.
  assert.match(
    src,
    /import\s*\{[^}]*\benqueue\b[^}]*\}\s*from\s*["']@gml\/db\/queue["']/,
    "route must queue the WhatsApp fetch through @gml/db/queue",
  );
  assert.match(src, /queue\s*:\s*WHATSAPP_QUEUE/, "the fetch goes on the whatsapp queue, not behind a transcode");
  const src2 = code(src);
  assert.ok(
    !/@gml\/worker/.test(src2),
    "route must not reference @gml/worker -- importing it is what pulled BullMQ, " +
      "ioredis and the entire worker tree into the web container image",
  );
  assert.ok(
    !/\btranscodeQueue\b/.test(src2),
    "the BullMQ Queue object no longer exists",
  );
  assert.ok(
    !/\bafter\s*\(/.test(src2),
    "no ingest work may be deferred to after(): Meta already has its 200, so a failure there is final",
  );
});

test("spec 105: the fetch is queued AFTER the insert, and the transcode only after the bytes are stored", () => {
  // The ORDERING is the part of this test that was never about BullMQ: a job
  // payload carries the submission id, so the row has to exist before the
  // worker is told to look for it -- and a transcode needs an object to read.
  const src = read(ROUTE_PATH);
  const insertIdx = src.search(/\.insert\s*\(\s*videoSubmissions\s*\)/);
  const enqueueIdx = src.search(/\bawait\s+enqueue\s*\(/);
  assert.ok(insertIdx > -1, "route must insert into videoSubmissions");
  assert.ok(enqueueIdx > -1, "route must queue the fetch");
  assert.ok(enqueueIdx > insertIdx, `the fetch must be queued AFTER the insert (insert=${insertIdx}, enqueue=${enqueueIdx})`);

  const worker = read(FETCH_PATH);
  const putIdx = worker.search(/await\s+deps\.put\s*\(/);
  const transcodeIdx = worker.search(/queue\s*:\s*["']transcode["']/);
  assert.ok(putIdx > -1, "the worker must store the bytes");
  assert.ok(transcodeIdx > -1, "the worker must queue the transcode");
  assert.ok(transcodeIdx > putIdx, "the transcode must be queued only once the bytes are in Storage");
});

test("spec 105: the transcode payload carries the four object coordinates and NOT source", () => {
  const src = read(FETCH_PATH);
  const call = src.match(/queue\s*:\s*["']transcode["'][\s\S]*?payload\s*:\s*\{([^}]*)\}/);
  assert.ok(call, "whatsapp-fetch.ts must queue the transcode with an object-literal payload");
  const payload = call[1];
  for (const field of ["videoSubmissionId", "fileId", "bucket", "objectKey"]) {
    assert.match(payload, new RegExp(`\\b${field}\\s*[:,}]`), `payload must include ${field}`);
  }

  // INVERTED long ago and still true: every source is re-encoded, so nothing
  // downstream may branch on provenance, and the payload must not carry it.
  assert.ok(
    !/\bsource\b/.test(payload),
    "the transcode payload must not carry a `source` discriminator",
  );

  // The provenance is still recorded where it belongs: on the audit row.
  assert.match(
    src,
    /["']transcode\.enqueued["'][\s\S]{0,400}?source\s*:\s*["']whatsapp["']/,
    "the audit metadata must still record source:'whatsapp'",
  );
});

test("spec 105: the WhatsApp path audits 'transcode.enqueued' against the video_submission", () => {
  const src = read(FETCH_PATH);
  assert.match(src, /audit\(\s*["']transcode\.enqueued["']\s*,\s*p\.videoSubmissionId/, "worker must audit 'transcode.enqueued' for the submission");
  assert.match(
    src,
    /insert\(auditLog\)\.values\(\{[^}]*entityType\s*:\s*["']video_submission["']/,
    "the worker's audit rows must reference entityType 'video_submission'",
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
