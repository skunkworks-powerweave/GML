import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

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

test("spec 105: webhook route imports transcodeQueue from @gml/worker", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /import\s*\{[^}]*\btranscodeQueue\b[^}]*\}\s*from\s*["']@gml\/worker(?:\/queues)?["']/,
    "route must import transcodeQueue from @gml/worker or @gml/worker/queues",
  );
});

test("spec 105: route calls transcodeQueue.add after the video_submissions insert", () => {
  const src = read(ROUTE_PATH);
  const insertIdx = src.search(/\.insert\s*\(\s*videoSubmissions\s*\)/);
  const addIdx = src.search(/transcodeQueue\.add\s*\(/);
  assert.ok(insertIdx > -1, "route must insert into videoSubmissions");
  assert.ok(addIdx > -1, "route must call transcodeQueue.add(...)");
  assert.ok(
    addIdx > insertIdx,
    "transcodeQueue.add must be called AFTER the videoSubmissions insert (got insertIdx=" +
      insertIdx +
      ", addIdx=" +
      addIdx +
      ")",
  );
});

test("spec 105: transcodeQueue.add payload uses queue name 'transcode' and passes source: 'whatsapp'", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /transcodeQueue\.add\s*\(\s*["']transcode["']/,
    "add() must target the 'transcode' queue by name",
  );
  // The payload must carry source:'whatsapp' so the worker takes the
  // skip-re-encode-but-still-package branch.
  assert.match(
    src,
    /source\s*:\s*["']whatsapp["']/,
    "transcodeQueue.add payload must include source:'whatsapp'",
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

test("spec 105: apps/web declares @gml/worker as a workspace dependency", () => {
  const pkg = JSON.parse(read(WEB_PKG));
  assert.ok(pkg.dependencies, "apps/web package.json must have dependencies");
  assert.equal(
    pkg.dependencies["@gml/worker"],
    "workspace:*",
    "apps/web must depend on @gml/worker via workspace:*",
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
