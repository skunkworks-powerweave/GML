// The observation nav badge counts the cycles the viewer can SEE, and the gated
// badges show nothing while their section is locked.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// loadNavCounts counted, for role 'mentor' and role 'teacher',
//
//     observation_cycles WHERE status IN (pre_submitted, observed, post_submitted)
//
// with no teacher or mentee predicate and no section-gate check. Every
// teacher's "My observations" badge and every mentor's "Observation cycles"
// badge showed the programme-wide in-flight total -- a number wrong for them,
// and a disclosure of programme activity outside the gate: /observation scopes
// even its chip counts with cycleVisibility because a count is itself a leak.
// 'nominated' -- the one state in which a teacher owes something -- was not
// counted at all.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// lib/nav-counts.ts is what loadNavCounts (lib/chrome-counts.ts) runs, bound
// there to the app's db and cached per request. Here it runs against a
// committed programme (./_observation-world.ts) through a plain pg client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { navCounts } from "../../apps/web/src/lib/nav-counts.ts";
import type { Db } from "../../apps/web/src/lib/visibility.ts";

const skip = needsDatabase();

test("teacher, mentor and observer badges count their own open cycles, and only behind the gate", { skip }, async () => {
  const w = await observationWorld("navcount");
  const db = drizzle(w.c) as unknown as Db;
  // A second teacher at the same school whom nobody in the world is linked to.
  const otherTeacher = (
    await w.c.query(`INSERT INTO teachers (school_id, full_name) VALUES ($1, $2) RETURNING id`, [w.schoolId, `Other ${w.T}`])
  ).rows[0].id as string;
  try {
    await w.cycle({ status: "nominated" });
    await w.cycle({ status: "observed" });
    await w.cycle({ status: "complete" });
    await w.cycle({ status: "pre_submitted", observerId: w.otherObserver.id });
    for (const status of ["pre_submitted", "observed", "post_submitted"]) {
      await w.c.query(
        `INSERT INTO observation_cycles (code, teacher_id, kind, status) VALUES ($1, $2, 'baseline', $3::observation_status)`,
        [`${w.T}-X-${status}`, otherTeacher, status],
      );
    }

    // No grant yet: the section is locked, so there is no number to show.
    for (const u of [w.teacher, w.mentor, w.observer]) {
      const counts = await navCounts(db, u.id, u.role as never);
      assert.equal(counts.cycles, undefined, `${u.role} has not unlocked /observation; no badge, no count`);
    }

    for (const u of [w.teacher, w.mentor, w.observer]) await w.grant(u.id);
    assert.equal((await navCounts(db, w.teacher.id, "teacher")).cycles, 3, "her own open cycles, nominated included");
    assert.equal((await navCounts(db, w.mentor.id, "mentor")).cycles, 3, "only the mentee's cycles");
    assert.equal((await navCounts(db, w.observer.id, "observer")).cycles, 2, "only cycles this observer is assigned to");
  } finally {
    await w.c.query(`DELETE FROM observation_cycles WHERE teacher_id = $1`, [otherTeacher]);
    await w.c.query(`DELETE FROM teachers WHERE id = $1`, [otherTeacher]);
    await w.cleanup();
  }
});

// The same rule for the other gated section. "My mentees" counted the mentor's
// pairings -- mentorship rows -- with no mentorship grant, while the section
// itself and the dashboard's mentorship cards are behind that gate.
test("the mentor's mentees badge is withheld until the mentorship section is unlocked", { skip }, async () => {
  const w = await observationWorld("navmentees");
  const db = drizzle(w.c) as unknown as Db;
  try {
    await w.grant(w.mentor.id); // observation only
    assert.equal((await navCounts(db, w.mentor.id, "mentor")).mentees, undefined, "mentorship locked: no badge, no count");
    await w.grant(w.mentor.id, "mentorship");
    assert.equal((await navCounts(db, w.mentor.id, "mentor")).mentees, 1, "his one active pairing");
  } finally {
    await w.cleanup();
  }
});

test("FR-10: mentors and observers reach the teach-back queue, and its badge keeps an overdue clip", { skip }, async () => {
  // The mentor's "Pending review" item linked to /videos, which has no review
  // control, and observers (who may review) had no link at all.
  const { NAV_BY_ROLE, activeNavIdFor } = await import("../../apps/web/src/config/nav.ts");
  for (const role of ["mentor", "observer"] as const) {
    const item = NAV_BY_ROLE[role].flatMap((s) => s.items).find((i) => i.href.startsWith("/rtt/teach-back"));
    assert.ok(item, `the ${role} nav links to the teach-back queue`);
    assert.equal(activeNavIdFor(role, "/rtt/teach-back"), item.id, `${role}: the item is highlighted on the queue`);
  }

  // The badge ANDed a 30-day window onto the shared predicate, so the clip
  // that had waited longest dropped out of it while /rtt/teach-back kept it.
  const w = await observationWorld("navteach");
  const db = drizzle(w.c) as unknown as Db;
  let fileId: string | undefined;
  try {
    const before = (await navCounts(db, w.mentor.id, "mentor")).pendingReview ?? 0;
    fileId = (
      await w.c.query(
        `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos', $1, 'video/mp4', 'video_original', 'stored') RETURNING id`,
        [`test/${w.T}/teach-back`],
      )
    ).rows[0].id as string;
    await w.c.query(
      `INSERT INTO video_submissions (file_id, source, status, context_type, hls_master_key, verified_at, created_at)
       VALUES ($1, 'direct', 'ready', 'teach_back', 'hls/test/master.m3u8', now(), now() - interval '40 days')`,
      [fileId],
    );
    const mentor = (await navCounts(db, w.mentor.id, "mentor")).pendingReview ?? 0;
    assert.ok(mentor >= before + 1, `a 40-day-old unreviewed teach-back is counted (${before} -> ${mentor})`);
    assert.ok(((await navCounts(db, w.observer.id, "observer")).pendingReview ?? 0) >= 1, "the observer's badge counts it too");
  } finally {
    if (fileId) {
      await w.c.query(`DELETE FROM video_submissions WHERE file_id = $1`, [fileId]);
      await w.c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    }
    await w.cleanup();
  }
});
