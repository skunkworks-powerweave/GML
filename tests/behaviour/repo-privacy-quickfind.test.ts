// Quick find (Cmd+K, GET /api/quickfind) gives a teacher her own records and
// the shared reference material, never a colleague's -- executed: the real
// route handler, signed in, against Postgres.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The palette searched teachers, schools, classes, outlines and sessions for
// everyone alike, so a teacher typing a colleague's name, her school's code or
// a word from a session topic was handed the colleague's record, the other
// schools, other teachers' classes, their lesson plans and their sessions --
// the same records the Repository now hides from her (repo-privacy-pages).
// The product owner's decision (docs/superpowers/specs/2026-09-28-teaching-
// records-design.md): quick find is limited in the same way; subjects, reading
// material and RTT content stay searchable. Mentors and administrators keep
// the programme-wide search.
//
// The tag in every fixture name, code and topic means one search reaches
// every row an unscoped query would return.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase, withClient } from "./_harness.js";
import { privacyWorld, type PrivacyWorld } from "./_repo-privacy-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

type Result = { kind: string; id: string; label: string; href: string };

async function quickfind(q: string): Promise<Result[]> {
  const { GET } = await import("../../apps/web/src/app/api/quickfind/route.ts");
  const res = await GET(new Request(`http://x/api/quickfind?q=${encodeURIComponent(q)}`));
  assert.equal(res.status, 200, `quickfind answered ${res.status}`);
  return ((await res.json()) as { results: Result[] }).results;
}

/** The ids found, per kind, sorted. */
async function found(q: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const r of await quickfind(q)) (out[r.kind] ??= []).push(r.id);
  for (const k of Object.keys(out)) out[k]!.sort();
  return out;
}

const sorted = (...ids: string[]) => [...ids].sort();

async function withWorld(body: (w: PrivacyWorld) => Promise<void>): Promise<void> {
  await withClient(async (c) => {
    const w = await privacyWorld(c, "rprvqf");
    try {
      await body(w);
    } finally {
      signIn(null);
      await w.f.cleanup();
    }
  });
}

test("a teacher's quick find returns her own records and reference data, and nothing of a colleague's", { skip }, async () => {
  await withWorld(async (w) => {
    signIn({ id: w.users.teacherA, role: "teacher" });
    assert.deepEqual(await found(w.T), {
      teacher: [w.teacherA],
      school: [w.schoolS1],
      // K1 is found by its class teacher's name; K2, which carries the tag the
      // same way, is teacher B's.
      class: [w.classK1],
      subject: [w.subject],
      outline: sorted(w.outlineP, w.planA),
      session: [w.sessionA],
      resource: [w.resource],
      // Her RTT scope: the programme-wide subject and her own zone's.
      rtt_subject: sorted(w.rttWide, w.rttZ1),
    });

    // Looking a colleague up by name, or her session by its topic, finds nothing.
    assert.deepEqual(await found(w.names.teacherB), {});
    assert.deepEqual(await found(w.topicB), {});
    assert.deepEqual(await found(w.names.planB), {});
    assert.deepEqual(await found(w.names.schoolS2), {});
  });
});

test("a teacher login with no teachers record finds only reference data", { skip }, async () => {
  await withWorld(async (w) => {
    signIn({ id: w.users.noRow, role: "teacher" });
    assert.deepEqual(await found(w.T), {
      subject: [w.subject],
      outline: [w.outlineP],
      resource: [w.resource],
      rtt_subject: [w.rttWide],
    });
  });
});

test("administrators and mentors keep the programme-wide quick find", { skip }, async () => {
  await withWorld(async (w) => {
    for (const [id, role] of [
      [w.users.admin, "programme_admin"],
      [w.users.mentor, "mentor"],
    ] as const) {
      signIn({ id, role });
      const hits = await found(w.T);
      assert.deepEqual(hits.teacher, sorted(w.teacherA, w.teacherB), `${role}: teachers`);
      assert.deepEqual(hits.school, sorted(w.schoolS1, w.schoolS2), `${role}: schools`);
      assert.deepEqual(hits.class, sorted(w.classK1, w.classK2), `${role}: classes`);
      assert.deepEqual(hits.outline, sorted(w.outlineP, w.outlinePD, w.planA, w.planB), `${role}: outlines`);
      assert.deepEqual(hits.session, sorted(w.sessionA, w.sessionB), `${role}: sessions`);
      assert.deepEqual(hits.resource, [w.resource], `${role}: reading material`);
      assert.deepEqual(hits.rtt_subject, sorted(w.rttWide, w.rttZ1, w.rttZ2), `${role}: RTT subjects`);
    }
  });
});
