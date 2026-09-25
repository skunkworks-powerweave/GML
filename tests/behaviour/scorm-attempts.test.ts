// POST /api/scorm/attempts/<package id> -- where the runtime's LMSCommit and
// LMSFinish land. The real route handler, against Postgres.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - The record is the SIGNED-IN learner's, whatever the body says.
//   - The body is not trusted: JSON only (a cross-site form cannot send it
//     without a preflight this route never answers), bounded, and every field
//     validated (lib/scorm/cmi.ts) before anything is written.
//   - Only a package the learner may launch accepts a commit.
//   - LMSFinish is audited with what the SCO reported; the many LMSCommits of
//     a session are not, and docs/audit-actions.md documents the row.
//   - End to end: a SCO driving the real runtime, through this route, is
//     resumed on relaunch from what it committed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

async function withPackage(body: (x: { w: RttWorld; pkgId: string; farId: string }) => Promise<void>) {
  const w = await rttWorld("scco");
  try {
    const { insertPackage } = await import("../../apps/web/src/lib/scorm/store.ts");
    const db = drizzle(w.c);
    const make = async (subjectId: string) =>
      insertPackage(db, {
        id: randomUUID(),
        rttSubjectId: subjectId,
        title: `Pkg ${w.T}`,
        manifestIdentifier: "x",
        launchPath: "index.html",
        launchQuery: "",
        masteryScore: null,
        launchData: null,
        uploadedByUserId: w.admin.id,
        totalBytes: 1,
        files: [],
      });
    await body({ w, pkgId: await make(await w.subject({ zoneId: w.zoneId })), farId: await make(await w.subject({ zoneId: w.zoneYId })) });
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

const commitBody = (over: Record<string, unknown> = {}) => ({
  sessionId: randomUUID(),
  lessonStatus: "incomplete",
  lessonLocation: "p1",
  scoreRaw: null,
  scoreMin: null,
  scoreMax: null,
  suspendData: "s=1",
  exit: "suspend",
  sessionTimeCs: 1200,
  final: false,
  ...over,
});

async function post(id: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const { POST } = await import("../../apps/web/src/app/api/scorm/attempts/[id]/route.ts");
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return POST(new Request(`http://app.test/api/scorm/attempts/${id}`, { method: "POST", headers, body: text }), {
    params: Promise.resolve({ id }),
  });
}

const attempt = async (w: RttWorld, pkgId: string, userId: string) =>
  (await w.c.query(`SELECT * FROM scorm_attempts WHERE package_id = $1 AND user_id = $2`, [pkgId, userId])).rows[0];

test("a commit is recorded for the signed-in learner, whatever the body claims", { skip }, async () => {
  await withPackage(async ({ w, pkgId }) => {
    const other = await w.user("Other", "teacher");
    signIn(w.teacher);
    const res = await post(pkgId, commitBody({ userId: other.id, user_id: other.id }));
    assert.equal(res.status, 200);
    const mine = await attempt(w, pkgId, w.teacher.id);
    assert.equal(mine?.suspend_data, "s=1");
    assert.equal(mine?.lesson_location, "p1");
    assert.equal(await attempt(w, pkgId, other.id), undefined, "nobody else's record is touched");
  });
});

test("the route refuses what it cannot trust, and writes nothing", { skip }, async () => {
  await withPackage(async ({ w, pkgId, farId }) => {
    signIn(null);
    assert.equal((await post(pkgId, commitBody())).status, 401);

    signIn(w.teacher);
    assert.equal((await post(pkgId, commitBody(), { "content-type": "text/plain" })).status, 415, "a cross-site form can send text/plain");
    assert.equal((await post(pkgId, commitBody(), {})).status, 415);
    assert.equal((await post(pkgId, "{not json", { "content-type": "application/json" })).status, 400);
    assert.equal((await post(pkgId, commitBody({ lessonStatus: "aced" }))).status, 400);
    assert.equal((await post(pkgId, commitBody({ suspendData: "x".repeat(4097) }))).status, 400);
    const huge = await post(pkgId, commitBody(), { "content-type": "application/json", "content-length": String(1024 * 1024) });
    assert.equal(huge.status, 413);
    assert.equal((await post(farId, commitBody())).status, 404, "a package she may not launch");
    assert.equal((await post("nope", commitBody())).status, 404);
    await w.c.query(`UPDATE scorm_packages SET active = false WHERE id = $1`, [pkgId]);
    assert.equal((await post(pkgId, commitBody())).status, 404, "withdrawn");
    assert.equal(await attempt(w, pkgId, w.teacher.id), undefined);
  });
});

test("LMSFinish is audited with what the SCO reported, LMSCommit is not, and the doc describes the row", { skip }, async () => {
  await withPackage(async ({ w, pkgId }) => {
    signIn(w.teacher);
    await post(pkgId, commitBody());
    await post(pkgId, commitBody({ lessonStatus: "passed", scoreRaw: 90, exit: "", final: true }));
    const { rows } = await w.c.query(
      `SELECT action, entity_type, entity_id, user_id, metadata FROM audit_log WHERE entity_id = $1 AND action LIKE 'scorm.%' ORDER BY created_at`,
      [pkgId],
    );
    assert.deepEqual(
      rows.map((r) => [r.action, r.entity_type, r.user_id]),
      [["scorm.attempt.finish", "scorm_package", w.teacher.id]],
    );
    assert.deepEqual(rows[0].metadata, { lessonStatus: "passed", scoreRaw: 90, sessionTimeCs: 1200 });

    const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
    const start = doc.indexOf("## scorm.*");
    assert.ok(start >= 0, "docs/audit-actions.md has a scorm.* section");
    const line = doc.slice(start).split("\n").find((l) => l.startsWith("| `scorm.attempt.finish` |"));
    assert.ok(line, "scorm.attempt.finish is documented");
    for (const key of [...Object.keys(rows[0].metadata), "scorm_package"]) assert.ok(line!.includes(`\`${key}\``), `${key} is documented`);
  });
});

test("end to end: a SCO driving the real runtime through this route is resumed on relaunch", { skip }, async () => {
  await withPackage(async ({ w, pkgId }) => {
    const { Scorm12Runtime } = await import("../../apps/web/src/lib/scorm/runtime.ts");
    const { launchState } = await import("../../apps/web/src/lib/scorm/store.ts");
    signIn(w.teacher);
    const db = drizzle(w.c);
    const pending: Array<Promise<Response>> = [];
    const launch = async () => {
      const state = await launchState(db, w.teacher.id, pkgId);
      return new Scorm12Runtime({ ...state, studentId: w.teacher.id, studentName: w.teacher.name, launchData: null, masteryScore: null }, (p) => {
        pending.push(post(pkgId, p));
        return true;
      });
    };

    const first = (await launch()).api;
    first.LMSInitialize("");
    assert.equal(first.LMSGetValue("cmi.core.entry"), "ab-initio");
    first.LMSSetValue("cmi.core.lesson_status", "incomplete");
    first.LMSSetValue("cmi.core.lesson_location", "slide-4");
    first.LMSSetValue("cmi.suspend_data", "answers=abc");
    first.LMSSetValue("cmi.core.exit", "suspend");
    first.LMSSetValue("cmi.core.session_time", "0000:03:00");
    first.LMSFinish("");
    for (const r of await Promise.all(pending.splice(0))) assert.equal(r.status, 200);

    const second = (await launch()).api;
    second.LMSInitialize("");
    assert.equal(second.LMSGetValue("cmi.core.entry"), "resume");
    assert.equal(second.LMSGetValue("cmi.core.lesson_location"), "slide-4");
    assert.equal(second.LMSGetValue("cmi.suspend_data"), "answers=abc");
    assert.equal(second.LMSGetValue("cmi.core.total_time"), "0000:03:00.00");
    second.LMSSetValue("cmi.core.lesson_status", "passed");
    second.LMSSetValue("cmi.core.score.raw", "88");
    second.LMSSetValue("cmi.core.session_time", "0000:01:30");
    second.LMSFinish("");
    for (const r of await Promise.all(pending.splice(0))) assert.equal(r.status, 200);

    const row = await attempt(w, pkgId, w.teacher.id);
    assert.equal(row.lesson_status, "passed");
    assert.equal(row.score_raw, 88);
    assert.equal(Number(row.total_time_cs) + Number(row.session_time_cs), 27000, "3:00 + 1:30, each counted once");
  });
});
