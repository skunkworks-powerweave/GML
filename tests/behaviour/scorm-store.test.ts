// SCORM 1.2 storage: the bucket, the package rows, and a learner's record --
// executed against Postgres.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - _post/009 creates a PRIVATE bucket that accepts only opaque bytes (the
//     served type comes from lib/scorm/files.ts), and it is the bucket
//     @gml/shared names.
//   - A package's files are servable by exact path only, and only to a viewer
//     who may launch the package: its subject is taught in her place
//     (lib/rtt/scope.ts) and it has not been withdrawn -- an administrator
//     still reaches a withdrawn one.
//   - A commit records the SCO's state. Session time counts ONCE per session,
//     even when the session never calls LMSFinish (a closed tab): repeated
//     commits of one session replace its time, and the next session folds it
//     into the total. A later, lower status (reopening a passed module to
//     review it) does not erase the learner's best outcome.
//   - A relaunch resumes: suspend data, location, and entry "resume" after an
//     exit of "suspend".
//   - Staff see every learner's status, score and time.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";
import { BUCKETS } from "../../packages/shared/src/storage/buckets.ts";
import { parseCommitPayload, type CommitPayload } from "../../apps/web/src/lib/scorm/cmi.ts";
import {
  commitAttempt,
  insertPackage,
  launchState,
  packageForViewer,
  packageSummaries,
  packageTracking,
  servableFile,
  setPackageActive,
  subjectPackages,
} from "../../apps/web/src/lib/scorm/store.ts";

const skip = needsDatabase();
after(async () => {
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end().catch(() => undefined);
});

const POST = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "packages/db/src/migrations/_post/009_scorm_bucket.sql");

test("_post/009 creates the private scorm-packages bucket, opaque bytes only, and @gml/shared names it", { skip }, async () => {
  // Run against a scratch schema standing in for `storage`, so this cannot
  // race the suites that build a stand-in `storage` of their own.
  const probe = `scorm_probe_${tag("b").replace(/[^a-z0-9]/g, "")}`;
  const sql = readFileSync(POST, "utf8").split("storage.buckets").join(`${probe}.buckets`);
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`CREATE SCHEMA ${probe}`);
      await c.query(
        `CREATE TABLE ${probe}.buckets (id text PRIMARY KEY, name text NOT NULL UNIQUE, public boolean DEFAULT false,
           file_size_limit bigint, allowed_mime_types text[])`,
      );
      await c.query(sql);
      await c.query(sql); // re-runnable: ON CONFLICT reconciles
      const { rows } = await c.query(`SELECT * FROM ${probe}.buckets`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, BUCKETS.scormPackages);
      assert.equal(rows[0].public, false, "reads are proxied after an access check, never a public URL");
      assert.equal(Number(rows[0].file_size_limit), 50 * 1024 * 1024);
      assert.deepEqual(rows[0].allowed_mime_types, ["application/octet-stream"]);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

function sample(subjectId: string, uploadedBy: string | null, id = randomUUID()) {
  return {
    id,
    rttSubjectId: subjectId,
    title: `Phonics ${id.slice(0, 6)}`,
    manifestIdentifier: "com.example.course",
    launchPath: "sco/index.html",
    launchQuery: "?lang=bo",
    masteryScore: 80,
    launchData: "start=2",
    uploadedByUserId: uploadedBy,
    totalBytes: 30,
    files: [
      { path: "imsmanifest.xml", objectKey: `${id}/0`, sizeBytes: 10 },
      { path: "sco/index.html", objectKey: `${id}/1`, sizeBytes: 20 },
    ],
  };
}

function payload(over: Partial<CommitPayload>): CommitPayload {
  return {
    sessionId: randomUUID(),
    lessonStatus: "incomplete",
    lessonLocation: "",
    scoreRaw: null,
    scoreMin: null,
    scoreMax: null,
    suspendData: "",
    exit: "",
    sessionTimeCs: 0,
    ...over,
  };
}

test("a package's files are servable by exact path, only to a viewer who may launch the package", { skip }, async () => {
  const w = await rttWorld("scst");
  try {
    const db = drizzle(w.c);
    const here = await w.subject({ zoneId: w.zoneId });
    const elsewhere = await w.subject({ zoneId: w.zoneYId });
    const pkgId = await insertPackage(db, sample(here, w.admin.id));
    const farId = await insertPackage(db, sample(elsewhere, w.admin.id));
    const teacher = { id: w.teacher.id, role: "teacher" };
    const admin = { id: w.admin.id, role: "programme_admin" };

    assert.equal((await servableFile(db, teacher, pkgId, "sco/index.html"))?.objectKey, `${pkgId}/1`);
    assert.equal(await servableFile(db, teacher, pkgId, "index.html"), null, "exact path only");
    assert.equal(await servableFile(db, teacher, pkgId, "sco/../imsmanifest.xml"), null, "no normalising a path into a match");
    assert.equal(await servableFile(db, teacher, farId, "sco/index.html"), null, "a subject not taught in her place");
    assert.equal(await servableFile(db, teacher, "not-a-uuid", "sco/index.html"), null, "a malformed id is a miss, not a 500");

    const launched = await packageForViewer(db, teacher, pkgId);
    assert.equal(launched?.launchPath, "sco/index.html");
    assert.equal(launched?.launchQuery, "?lang=bo");
    assert.equal(launched?.masteryScore, 80);
    assert.equal(await packageForViewer(db, teacher, farId), null);

    await setPackageActive(db, pkgId, false);
    assert.equal(await servableFile(db, teacher, pkgId, "sco/index.html"), null, "withdrawn");
    assert.equal(await packageForViewer(db, teacher, pkgId), null, "withdrawn");
    assert.ok(await servableFile(db, admin, pkgId, "sco/index.html"), "an administrator still reaches it");
    assert.ok(await packageForViewer(db, admin, pkgId));
  } finally {
    await w.cleanup();
  }
});

test("a commit records the SCO's state; each session's time counts once; the best status is kept", { skip }, async () => {
  const w = await rttWorld("scat");
  try {
    const db = drizzle(w.c);
    const pkgId = await insertPackage(db, sample(await w.subject(), w.admin.id));
    const me = w.teacher.id;
    const row = async () =>
      (await w.c.query(`SELECT * FROM scorm_attempts WHERE package_id = $1 AND user_id = $2`, [pkgId, me])).rows[0];

    const first = await launchState(db, me, pkgId);
    assert.deepEqual(
      { status: first.lessonStatus, entry: first.entry, total: first.totalTimeCs, suspend: first.suspendData },
      { status: "not attempted", entry: "ab-initio", total: 0, suspend: "" },
    );

    const s1 = randomUUID();
    await commitAttempt(db, me, pkgId, payload({ sessionId: s1, sessionTimeCs: 3000, suspendData: "page=2", lessonLocation: "p2", exit: "suspend" }));
    await commitAttempt(db, me, pkgId, payload({ sessionId: s1, sessionTimeCs: 4500, suspendData: "page=3", lessonLocation: "p3", exit: "suspend" }));
    let r = await row();
    assert.equal(Number(r.session_time_cs), 4500, "a session's later commit REPLACES its time");
    assert.equal(Number(r.total_time_cs), 0);
    assert.equal(r.session_count, 1);
    assert.equal(r.completed_at, null);

    // The tab closed without LMSFinish. The relaunch resumes.
    const resumed = await launchState(db, me, pkgId);
    assert.equal(resumed.entry, "resume", "the last exit was suspend");
    assert.equal(resumed.suspendData, "page=3");
    assert.equal(resumed.lessonLocation, "p3");
    assert.equal(resumed.totalTimeCs, 4500, "earlier sessions' time, including the one that never finished");

    await commitAttempt(db, me, pkgId, payload({ lessonStatus: "passed", scoreRaw: 80, scoreMin: 0, scoreMax: 100, sessionTimeCs: 1000 }));
    r = await row();
    assert.equal(Number(r.total_time_cs), 4500, "the previous session folded in once");
    assert.equal(Number(r.session_time_cs), 1000);
    assert.equal(r.session_count, 2);
    assert.equal(r.lesson_status, "passed");
    assert.equal(r.score_raw, 80);
    assert.ok(r.completed_at instanceof Date, "first finish recorded");
    const completedAt = r.completed_at as Date;
    assert.equal((await launchState(db, me, pkgId)).entry, "", "not a suspend: no resume");

    // Reopened to review: the SCO says incomplete, then fails a retake.
    await commitAttempt(db, me, pkgId, payload({ lessonStatus: "incomplete", scoreRaw: 20, suspendData: "review", sessionTimeCs: 200 }));
    await commitAttempt(db, me, pkgId, payload({ lessonStatus: "failed", scoreRaw: 30, sessionTimeCs: 200 }));
    r = await row();
    assert.equal(r.lesson_status, "passed", "a lower status never replaces a better one");
    assert.equal(r.score_raw, 80, "and the score stays the one that went with it");
    assert.equal(r.suspend_data, "", "suspend data is always the latest");
    assert.equal(Number(r.total_time_cs), 4500 + 1000 + 200, "every earlier session counted exactly once");
    assert.equal((r.completed_at as Date).getTime(), completedAt.getTime(), "the first finish is kept");

    await commitAttempt(db, me, pkgId, payload({ lessonStatus: "passed", scoreRaw: 95, sessionTimeCs: 100 }));
    assert.equal((await row()).score_raw, 95, "an equal status takes the newer score");
  } finally {
    await w.cleanup();
  }
});

test("staff see every learner's status, score and time; learners see their own on the subject", { skip }, async () => {
  const w = await rttWorld("sctr");
  try {
    const db = drizzle(w.c);
    const subject = await w.subject();
    const pkgId = await insertPackage(db, sample(subject, w.admin.id));
    const hidden = await insertPackage(db, sample(subject, w.admin.id));
    await setPackageActive(db, hidden, false);
    const other = await w.user("Zed", "teacher");
    await commitAttempt(db, w.teacher.id, pkgId, payload({ lessonStatus: "passed", scoreRaw: 72.5, sessionTimeCs: 6000 }));
    await commitAttempt(db, other.id, pkgId, payload({ lessonStatus: "incomplete", sessionTimeCs: 1500 }));

    const rows = await packageTracking(db, pkgId);
    assert.deepEqual(
      rows.map((r) => [r.name, r.lessonStatus, r.scoreRaw, r.totalTimeCs, r.completedAt !== null]),
      [
        [w.teacher.name, "passed", 72.5, 6000, true],
        [other.name, "incomplete", null, 1500, false],
      ],
    );

    const mine = await subjectPackages(db, { id: w.teacher.id, role: "teacher" }, subject);
    assert.deepEqual(
      mine.map((p) => [p.id, p.lessonStatus, p.scoreRaw]),
      [[pkgId, "passed", 72.5]],
      "the withdrawn package is not offered",
    );
    const fresh = await subjectPackages(db, { id: w.observer.id, role: "observer" }, subject);
    assert.deepEqual(fresh.map((p) => p.lessonStatus), ["not attempted"]);

    const summary = (await packageSummaries(db)).find((s) => s.id === pkgId);
    assert.deepEqual({ learners: summary?.learners, finished: summary?.finished, files: summary?.fileCount }, { learners: 2, finished: 1, files: 2 });
  } finally {
    await w.cleanup();
  }
});

test("the commit body is validated field by field before it reaches the database", () => {
  const ok = payload({ sessionId: randomUUID().toUpperCase(), lessonStatus: "completed", scoreRaw: 55.5, suspendData: "x".repeat(4096), exit: "suspend", sessionTimeCs: 12 });
  assert.equal(parseCommitPayload(ok)?.sessionId, ok.sessionId.toLowerCase());
  const bad: Array<[string, unknown]> = [
    ["not an object", "x"],
    ["no session", { ...ok, sessionId: "abc" }],
    ["status outside the vocabulary", { ...ok, lessonStatus: "done" }],
    ["location over 255", { ...ok, lessonLocation: "x".repeat(256) }],
    ["score over 100", { ...ok, scoreRaw: 101 }],
    ["negative score", { ...ok, scoreMin: -1 }],
    ["score as a string", { ...ok, scoreMax: "50" }],
    ["suspend data over 4096", { ...ok, suspendData: "x".repeat(4097) }],
    ["exit outside the vocabulary", { ...ok, exit: "quit" }],
    ["fractional time", { ...ok, sessionTimeCs: 1.5 }],
    ["negative time", { ...ok, sessionTimeCs: -1 }],
  ];
  for (const [why, body] of bad) assert.equal(parseCommitPayload(body), null, why);
});
