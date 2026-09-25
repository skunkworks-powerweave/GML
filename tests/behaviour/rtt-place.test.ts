// District > zone in RTT: what a teacher is shown by default, and how staff
// navigate and filter, rendered for real.
//
// ── THE DEFECT (F42) ─────────────────────────────────────────────────────────
//
// RTT is organised district > zone > term > subject, but rtt_subjects carried
// only a term and nothing above it had any geography. /rtt listed every
// subject of every phase to every user under a hard-coded "across Leh +
// Kargil", never looked at the teacher's own zone or current phase, and offered
// staff no way to look at one district or zone.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL /rtt, subject page and /rtt/progress, through the app's own @gml/db
// pool, for users of a small committed programme (./_rtt-world.ts): district D
// with zones Z (the teacher's school) and Z2, and district D2 with zone Y.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, outcome, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(closeAppDb);

const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const hrefs = (html: string) => openingTags(html, "a").map((t) => attr(t, "href") ?? "");

async function hub(user: TestUser, sp: Record<string, string> = {}): Promise<string> {
  signIn(user);
  const { default: RttIndexPage } = await import("../../apps/web/src/app/(authenticated)/rtt/page.tsx");
  return render(withAppRouter(await RttIndexPage({ searchParams: Promise.resolve(sp) })));
}

/** One subject for each place the world has, named after it. */
async function places(w: RttWorld) {
  return {
    all: await w.subject({ name: `Everywhere ${w.T}` }),
    d: await w.subject({ name: `District D ${w.T}`, districtId: w.districtId }),
    z: await w.subject({ name: `Zone Z ${w.T}`, zoneId: w.zoneId }),
    z2: await w.subject({ name: `Zone Z2 ${w.T}`, zoneId: w.zone2Id }),
    d2: await w.subject({ name: `District D2 ${w.T}`, districtId: w.district2Id }),
    y: await w.subject({ name: `Zone Y ${w.T}`, zoneId: w.zoneYId }),
  };
}

/** Which of the world's subjects a page links to, by place key. */
function linked(html: string, s: Record<string, string>): string[] {
  const h = hrefs(html);
  return Object.entries(s)
    .filter(([, id]) => h.includes(`/rtt/subject/${id}`))
    .map(([k]) => k)
    .sort();
}

test("F42: a teacher is shown the programme's, her district's and her zone's subjects -- not another zone's", { skip }, async () => {
  const w = await rttWorld("f42-teacher");
  try {
    const s = await places(w);
    await w.c.query(`UPDATE teachers SET current_phase_id = $1 WHERE id = $2`, [w.phaseId, w.teacherId]);

    const t = await hub(w.teacher);
    assert.deepEqual(linked(t, s), ["all", "d", "z"], "her track: programme-wide, district D, zone Z");
    assert.match(text(t), new RegExp(`Zone ${w.T}, District ${w.T}`), "the page says whose subjects these are");
    assert.doesNotMatch(text(t), /Leh \+ Kargil/, "no hard-coded geography");
    assert.match(text(t), /Your phase/, "her current phase is marked");

    // Asking for somewhere else changes nothing for a teacher.
    const asked = await hub(w.teacher, { district: w.district2Id, zone: w.zoneYId });
    assert.deepEqual(linked(asked, s), ["all", "d", "z"]);

    signIn(w.teacher);
    const { default: RttSubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
    const open = (id: string) =>
      outcome(async () =>
        render(withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }))),
      );
    assert.deepEqual(await open(s.z2), { kind: "notFound" }, "another zone's subject is not hers to open");
    assert.equal((await open(s.z)).kind, "returned");

    // Her open quizzes are her track's too.
    const mine = await w.quiz(s.z);
    const elsewhere = await w.quiz(s.y);
    const again = hrefs(await hub(w.teacher));
    assert.ok(again.includes(`/quizzes/${mine.slug}`));
    assert.ok(!again.includes(`/quizzes/${elsewhere.slug}`), "a quiz for zone Y is not open for a teacher in Z");
  } finally {
    await w.cleanup();
  }
});

test("F42: staff see everything by default and navigate district > zone", { skip }, async () => {
  const w = await rttWorld("f42-staff");
  try {
    const s = await places(w);
    for (const who of [w.admin, w.mentor, w.observer]) {
      const all = await hub(who);
      assert.deepEqual(linked(all, s), ["all", "d", "d2", "y", "z", "z2"], `${who.role}: the whole programme`);
      assert.ok(
        hrefs(all).some((h) => h.includes(`district=${w.districtId}`)),
        `${who.role}: a way into district D`,
      );
    }

    const d = await hub(w.admin, { district: w.districtId });
    assert.deepEqual(linked(d, s), ["all", "d", "z", "z2"], "district D: its own, its zones', and the programme's");
    assert.ok(hrefs(d).some((h) => h.includes(`zone=${w.zone2Id}`)), "and a way into each of its zones");
    assert.match(text(d), new RegExp(`in District ${w.T}`));

    const z2 = await hub(w.admin, { district: w.districtId, zone: w.zone2Id });
    assert.deepEqual(linked(z2, s), ["all", "d", "z2"], "zone Z2: not zone Z's");
    assert.match(text(z2), new RegExp(`in Zone2 ${w.T}, District ${w.T}`));

    // A zone names its district: a mismatched pair is read by the zone.
    const odd = await hub(w.admin, { district: w.district2Id, zone: w.zone2Id });
    assert.deepEqual(linked(odd, s), ["all", "d", "z2"]);

    // Staff may open any subject.
    signIn(w.observer);
    const { default: RttSubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
    const r = await outcome(async () =>
      render(withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id: s.y }), searchParams: Promise.resolve({}) }))),
    );
    assert.equal(r.kind, "returned");
  } finally {
    await w.cleanup();
  }
});

test("F42: staff filter quiz results and attendance by district and zone", { skip }, async () => {
  const w = await rttWorld("f42-progress");
  try {
    const subject = await w.subject({ name: `Shared ${w.T}` });
    const q = await w.quiz(subject, { title: `Place quiz ${w.T}` });
    const far = await w.addTeacher("Far", w.zoneYId);
    await w.submission(q.id, w.teacher.id, 70, true);
    await w.submission(q.id, far.user.id, 50, false);
    const near = `Teacher Row ${w.T}`;
    const farName = `Far Row ${w.T}`;

    signIn(w.admin);
    const { default: RttProgressPage } = await import("../../apps/web/src/app/(authenticated)/rtt/progress/page.tsx");
    const view = async (sp: Record<string, string>) =>
      text(await render(withAppRouter(await RttProgressPage({ searchParams: Promise.resolve({ subject, ...sp }) }))));

    const all = await view({});
    assert.ok(all.includes(near) && all.includes(farName), "every teacher by default");
    const y = await view({ district: w.district2Id, zone: w.zoneYId });
    assert.ok(y.includes(farName) && !y.includes(near), "zone Y: its teachers only");
    const d = await view({ district: w.districtId });
    assert.ok(d.includes(near) && !d.includes(farName), "district D: its teachers only");
  } finally {
    await w.cleanup();
  }
});

test("F42: a subject is scoped to one district or one zone, never both", { skip }, async () => {
  const w = await rttWorld("f42-check");
  try {
    await assert.rejects(
      () => w.subject({ districtId: w.districtId, zoneId: w.zoneId }),
      /rtt_subjects_one_place/,
      "a zone already names its district; both would be a place that can disagree with itself",
    );
    const { rttSubjectsEntity } = await import("../../apps/web/src/admin/entities/rtt-subjects.ts");
    const base = { name: "Scoped", termId: w.termId, active: true };
    assert.equal(rttSubjectsEntity.formSchema.safeParse({ ...base, zoneId: w.zoneId }).success, true);
    assert.equal(rttSubjectsEntity.formSchema.safeParse({ ...base, districtId: w.districtId }).success, true);
    assert.equal(
      rttSubjectsEntity.formSchema.safeParse({ ...base, districtId: w.districtId, zoneId: w.zoneId }).success,
      false,
      "the grid says so before the database has to",
    );
    assert.ok(rttSubjectsEntity.formFields.includes("districtId") && rttSubjectsEntity.formFields.includes("zoneId"));
  } finally {
    await w.cleanup();
  }
});
