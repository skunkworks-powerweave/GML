// Teachers' attendance at RTT sessions, taken by a programme admin on
// /attendance -- executed through the real pages and the real server action,
// against Postgres.
//
// ── THE GAP ──────────────────────────────────────────────────────────────────
//
// rtt_attendance had no screen. A mark was a row typed into the super_admin
// data grid (programme admins could not write it at all), nothing set
// marked_by_user_id, and the grid's status choices had no "late" although
// migration 0043 added it. So a teacher's "Sessions attended" and the staff
// attendance table read rows almost nobody could write. The design
// (docs/superpowers/specs/2026-09-28-teaching-records-design.md): a programme
// admin opens an RTT session, sees the teachers it covers, marks each one and
// saves.
//
// ── WHAT IS CHECKED ──────────────────────────────────────────────────────────
//
// Who may open and save (programme and super admins; nobody else, on the
// server); whose names the roster holds (the active teachers where the
// subject is taught, lib/rtt/scope.ts); that a save upserts one row per
// teacher stamped with who marked it and when, and leaves an unchanged mark's
// stamp alone; "Mark all present"; that a crafted post is refused whole; that
// "late" reaches the teacher; the audit row; the data-table entity; and the
// pages in Bhoti.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request, decodeEntities, openingTags, attr, SRC_DIR } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const listPage = () => import("../../apps/web/src/app/(authenticated)/attendance/page.tsx");
const sessionPage = () => import("../../apps/web/src/app/(authenticated)/attendance/[rttSessionId]/page.tsx");
const actions = () => import("../../apps/web/src/app/(authenticated)/attendance/[rttSessionId]/actions.ts");

const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

type World = RttWorld & {
  superAdmin: TestUser;
  /** A second teacher in the teacher's own zone Z. */
  sameZone: { user: TestUser; teacherId: string };
  /** A teacher in zone Z2 of the same district. */
  otherZone: { user: TestUser; teacherId: string };
  /** A teacher in the other district. */
  otherDistrict: { user: TestUser; teacherId: string };
  /** An INACTIVE teacher in zone Z. */
  inactive: { user: TestUser; teacherId: string };
  /** A dated session of a new subject scoped as asked. */
  sessionFor: (scope: "zone" | "district" | "programme", when?: Date | null) => Promise<{ subjectId: string; sessionId: string }>;
};

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await rttWorld("rttatt");
  try {
    const superAdmin = await w.user("Super", "super_admin");
    const sameZone = await w.addTeacher("Same");
    const otherZone = await w.addTeacher("Neighbour", w.zone2Id);
    const otherDistrict = await w.addTeacher("Far", w.zoneYId);
    const inactive = await w.addTeacher("Retired");
    await w.c.query(`UPDATE teachers SET active = false WHERE id = $1`, [inactive.teacherId]);
    let seq = 0;
    const sessionFor: World["sessionFor"] = async (scope, when = new Date(Date.now() - 86_400_000)) => {
      const subjectId = await w.subject(
        scope === "zone" ? { zoneId: w.zoneId } : scope === "district" ? { districtId: w.districtId } : {},
      );
      const sessionId = await w.session(subjectId, { sequence: ++seq, scheduledAt: when });
      return { subjectId, sessionId };
    };
    await body({ ...w, superAdmin, sameZone, otherZone, otherDistrict, inactive, sessionFor });
  } finally {
    signIn(null);
    request.locale = "en";
    await w.cleanup();
  }
}

async function renderSession(who: TestUser, id: string, sp: Record<string, string> = {}) {
  signIn(who);
  const { default: Page } = await sessionPage();
  const r = await outcome(async () =>
    render(withAppRouter(await Page({ params: Promise.resolve({ rttSessionId: id }), searchParams: Promise.resolve(sp) }))),
  );
  return r;
}

async function sessionHtml(who: TestUser, id: string, sp: Record<string, string> = {}): Promise<string> {
  const r = await renderSession(who, id, sp);
  assert.equal(r.kind, "returned", JSON.stringify(r));
  return String((r as { value: unknown }).value);
}

async function listHtml(who: TestUser, sp: Record<string, string> = {}) {
  signIn(who);
  const { default: Page } = await listPage();
  return outcome(async () => render(withAppRouter(await Page({ searchParams: Promise.resolve(sp) }))));
}

/** The teachers on the rendered roster, by teachers.id. */
const rosterIds = (html: string) =>
  openingTags(html, "li")
    .map((t) => attr(t, "data-teacher-id"))
    .filter((v): v is string => !!v);

async function save(who: TestUser, sessionId: string, marks: Record<string, string>, intent = "save") {
  signIn(who);
  const { saveAttendanceAction } = await actions();
  const fields: Record<string, string> = { rttSessionId: sessionId, intent };
  for (const [teacherId, status] of Object.entries(marks)) fields[`status:${teacherId}`] = status;
  return outcome(() => saveAttendanceAction(form(fields)));
}

async function marks(w: World, sessionId: string) {
  const rows = (
    await w.c.query<{ teacher_id: string; status: string; marked_by_user_id: string | null; marked_at: Date }>(
      `SELECT teacher_id, status, marked_by_user_id, marked_at FROM rtt_attendance WHERE rtt_session_id = $1`,
      [sessionId],
    )
  ).rows;
  return new Map(rows.map((r) => [r.teacher_id, r]));
}

// ── who may ──────────────────────────────────────────────────────────────────

test("only programme admins and super admins open /attendance and a session, and only they can save", { skip }, async () => {
  await withWorld(async (w) => {
    const { sessionId } = await w.sessionFor("zone");
    for (const who of [w.teacher, w.mentor, w.observer]) {
      assert.deepEqual(await listHtml(who), { kind: "redirect", location: "/forbidden" }, `${who.role}: the list`);
      assert.deepEqual(await renderSession(who, sessionId), { kind: "redirect", location: "/forbidden" }, `${who.role}: the session`);
      assert.deepEqual(
        await save(who, sessionId, { [w.teacherId]: "present" }),
        { kind: "redirect", location: "/forbidden" },
        `${who.role}: the action refuses, whatever the page showed`,
      );
    }
    assert.equal((await marks(w, sessionId)).size, 0, "nothing was written by any of them");
    signIn(null);
    const { saveAttendanceAction } = await actions();
    assert.deepEqual(
      await outcome(() => saveAttendanceAction(form({ rttSessionId: sessionId, [`status:${w.teacherId}`]: "present" }))),
      { kind: "redirect", location: "/login" },
      "signed out",
    );

    for (const who of [w.admin, w.superAdmin]) {
      const list = await listHtml(who);
      assert.equal(list.kind, "returned", `${who.role} opens the list`);
      assert.ok(String((list as { value: unknown }).value).includes(`href="/attendance/${sessionId}"`), "which links the session");
      assert.ok(rosterIds(await sessionHtml(who, sessionId)).includes(w.teacherId), `${who.role} opens the session`);
    }
  });
});

// ── the roster ───────────────────────────────────────────────────────────────

test("a session's roster is the active teachers where its subject is taught", { skip }, async () => {
  await withWorld(async (w) => {
    const zone = await w.sessionFor("zone");
    const district = await w.sessionFor("district");
    const programme = await w.sessionFor("programme");

    const inZone = rosterIds(await sessionHtml(w.admin, zone.sessionId));
    assert.ok(inZone.includes(w.teacherId) && inZone.includes(w.sameZone.teacherId), "the zone's teachers");
    assert.ok(!inZone.includes(w.otherZone.teacherId), "not the next zone's");
    assert.ok(!inZone.includes(w.otherDistrict.teacherId), "not another district's");
    assert.ok(!inZone.includes(w.inactive.teacherId), "not an inactive teacher");

    const inDistrict = rosterIds(await sessionHtml(w.admin, district.sessionId));
    assert.ok(inDistrict.includes(w.teacherId) && inDistrict.includes(w.otherZone.teacherId), "every zone of the district");
    assert.ok(!inDistrict.includes(w.otherDistrict.teacherId), "not another district's");
    assert.ok(!inDistrict.includes(w.inactive.teacherId));

    const everywhere = rosterIds(await sessionHtml(w.admin, programme.sessionId));
    for (const t of [w.teacherId, w.otherZone.teacherId, w.otherDistrict.teacherId]) {
      assert.ok(everywhere.includes(t), "a programme-wide subject is for every active teacher");
    }
    assert.ok(!everywhere.includes(w.inactive.teacherId));

    // The roster is enforced on the server: a teacher from elsewhere cannot be
    // marked by editing the form, and the save is refused whole.
    const r = await save(w.admin, zone.sessionId, { [w.teacherId]: "present", [w.otherDistrict.teacherId]: "present" });
    assert.deepEqual(r, { kind: "redirect", location: `/attendance/${zone.sessionId}?error=not_on_roster` });
    assert.equal((await marks(w, zone.sessionId)).size, 0, "nothing was saved");
    assert.match(text(await sessionHtml(w.admin, zone.sessionId, { error: "not_on_roster" })), /not on this session's roster/);

    // Someone marked here who has since left the roster is still shown, flagged.
    await w.c.query(
      `INSERT INTO rtt_attendance (rtt_session_id, teacher_id, status, marked_by_user_id) VALUES ($1, $2, 'present', $3)`,
      [zone.sessionId, w.inactive.teacherId, w.admin.id],
    );
    const withLeaver = await sessionHtml(w.admin, zone.sessionId);
    assert.ok(rosterIds(withLeaver).includes(w.inactive.teacherId), "an existing mark is not hidden");
    assert.match(text(withLeaver), /No longer on this roster/);
  });
});

// ── saving ───────────────────────────────────────────────────────────────────

test("saving upserts one row per teacher, stamped with who marked it and when; an unchanged mark keeps its stamp", { skip }, async () => {
  await withWorld(async (w) => {
    const { sessionId } = await w.sessionFor("district");

    const first = await save(w.admin, sessionId, { [w.teacherId]: "late", [w.otherZone.teacherId]: "absent" });
    assert.deepEqual(first, { kind: "redirect", location: `/attendance/${sessionId}?saved=2` });
    const one = await marks(w, sessionId);
    assert.equal(one.size, 2);
    assert.equal(one.get(w.teacherId)?.status, "late");
    assert.equal(one.get(w.teacherId)?.marked_by_user_id, w.admin.id);
    assert.equal(one.get(w.otherZone.teacherId)?.status, "absent");
    assert.ok(one.get(w.teacherId)!.marked_at instanceof Date);

    // The audit row, as docs/audit-actions.md describes it.
    const audit = (
      await w.c.query(`SELECT entity_type, entity_id, metadata FROM audit_log WHERE action = 'rtt.attendance.marked' AND user_id = $1`, [
        w.admin.id,
      ])
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_type, "rtt_session");
    assert.equal(audit[0].entity_id, sessionId);
    assert.deepEqual(audit[0].metadata, { changed: 2, counts: { present: 0, absent: 1, excused: 0, late: 1 }, allPresent: false });
    const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
    const row = doc.split("\n").find((l) => l.startsWith("| `rtt.attendance.marked` |"));
    assert.ok(row, "rtt.attendance.marked is documented");
    const metadataCell = row!.split("|").slice(1, -1)[2]!;
    const documented = new Set([...metadataCell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]));
    assert.deepEqual([...documented].sort(), Object.keys(audit[0].metadata).sort(), "the documented keys are the written ones");

    // A second save, by the super admin: the teacher's mark is the same, the
    // neighbour's changes. One row each still, and the unchanged row keeps
    // who took it and when.
    await new Promise((r) => setTimeout(r, 20));
    const second = await save(w.superAdmin, sessionId, { [w.teacherId]: "late", [w.otherZone.teacherId]: "excused" });
    assert.deepEqual(second, { kind: "redirect", location: `/attendance/${sessionId}?saved=1` });
    const two = await marks(w, sessionId);
    assert.equal(two.size, 2, "upserted, not duplicated");
    assert.equal(two.get(w.teacherId)?.marked_by_user_id, w.admin.id, "unchanged: still the admin's mark");
    assert.equal(two.get(w.teacherId)?.marked_at.getTime(), one.get(w.teacherId)?.marked_at.getTime());
    assert.equal(two.get(w.otherZone.teacherId)?.status, "excused");
    assert.equal(two.get(w.otherZone.teacherId)?.marked_by_user_id, w.superAdmin.id, "changed: now the super admin's");

    // The page shows each mark, who took it, and the choice checked.
    const html = await sessionHtml(w.admin, sessionId, { saved: "1" });
    assert.match(text(html), /Saved: 1 mark changed\./);
    assert.match(text(html), new RegExp(`Marked by Admin ${w.T}`));
    assert.match(text(html), new RegExp(`Marked by Super ${w.T}`));
    const checked = openingTags(html, "input").filter((t) => attr(t, "name") === `status:${w.teacherId}` && /\schecked=""/.test(t));
    assert.deepEqual(checked.map((t) => attr(t, "value")), ["late"], "her current mark is the one checked");
    assert.match(text(html), /0 present · 1 late · 0 absent · 1 excused/);

    // Saving nothing new writes nothing and audits nothing.
    assert.deepEqual(await save(w.admin, sessionId, { [w.teacherId]: "late" }), {
      kind: "redirect",
      location: `/attendance/${sessionId}?saved=0`,
    });
    const audits = await w.c.query(`SELECT 1 FROM audit_log WHERE action = 'rtt.attendance.marked' AND entity_id = $1`, [sessionId]);
    assert.equal(audits.rowCount, 2, "one audit row per save that changed something");
  });
});

test("Mark all present marks everyone left unmarked present, and keeps the choices made", { skip }, async () => {
  await withWorld(async (w) => {
    const { sessionId } = await w.sessionFor("zone");
    const r = await save(w.admin, sessionId, { [w.teacherId]: "absent" }, "all_present");
    assert.deepEqual(r, { kind: "redirect", location: `/attendance/${sessionId}?saved=2` });
    const m = await marks(w, sessionId);
    assert.equal(m.get(w.teacherId)?.status, "absent", "a choice made is kept");
    assert.equal(m.get(w.sameZone.teacherId)?.status, "present", "the rest are present");
    assert.equal(m.has(w.inactive.teacherId), false, "not someone off the roster");
    const audit = (
      await w.c.query(`SELECT metadata FROM audit_log WHERE action = 'rtt.attendance.marked' AND entity_id = $1`, [sessionId])
    ).rows;
    assert.equal(audit[0]?.metadata.allPresent, true);
  });
});

test("a crafted post is refused: an unknown status, a malformed id, a session that does not exist", { skip }, async () => {
  await withWorld(async (w) => {
    const { sessionId } = await w.sessionFor("zone");
    assert.deepEqual(await save(w.admin, sessionId, { [w.teacherId]: "asleep" }), {
      kind: "redirect",
      location: `/attendance/${sessionId}?error=invalid`,
    });
    assert.deepEqual(await save(w.admin, sessionId, { "not-a-uuid": "present" }), {
      kind: "redirect",
      location: `/attendance/${sessionId}?error=invalid`,
    });
    assert.equal((await marks(w, sessionId)).size, 0);
    assert.deepEqual(await save(w.admin, randomUUID(), { [w.teacherId]: "present" }), { kind: "notFound" });
    assert.deepEqual(await renderSession(w.admin, "nope"), { kind: "notFound" });
    assert.deepEqual(await renderSession(w.admin, randomUUID()), { kind: "notFound" });
  });
});

// ── the teacher sees it ──────────────────────────────────────────────────────

test("a teacher marked late sees Late on her subject page, and it counts as attended on /rtt/progress", { skip }, async () => {
  await withWorld(async (w) => {
    const { subjectId, sessionId } = await w.sessionFor("zone");
    await save(w.admin, sessionId, { [w.teacherId]: "late" });

    signIn(w.teacher);
    const { default: SubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
    const subject = await render(
      withAppRouter(await SubjectPage({ params: Promise.resolve({ id: subjectId }), searchParams: Promise.resolve({}) })),
    );
    const row = [...subject.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]!)).find((r) => r.includes(`Session 1 ${w.T}`));
    assert.ok(row, "the session is listed");
    assert.match(row!, /\bLate\b/, "her mark, in words");
    assert.match(subject, /class="chip chip-saffron">Late</);
    assert.match(text(subject), /Sessions attended 1 of 1/);

    const { default: ProgressPage } = await import("../../apps/web/src/app/(authenticated)/rtt/progress/page.tsx");
    const progress = text(await render(withAppRouter(await ProgressPage({ searchParams: Promise.resolve({}) }))));
    assert.match(progress, /1\/1 sessions attended/);

    // And staff see "Late" in the attendance table, not the raw value.
    signIn(w.admin);
    const staff = await render(withAppRouter(await ProgressPage({ searchParams: Promise.resolve({ subject: subjectId }) })));
    assert.match(staff, /class="chip chip-saffron">Late</);
  });
});

// ── the data table ───────────────────────────────────────────────────────────

test("the rtt-attendance data table: programme admins may write it, 'late' is a choice, and a grid write says who marked it", { skip }, async () => {
  await withWorld(async (w) => {
    const { ADMIN_ENTITIES } = await import("../../apps/web/src/admin/registry.ts");
    const entity = ADMIN_ENTITIES["rtt-attendance"]!;
    assert.deepEqual([...(entity.mutateRoles ?? [])].sort(), ["programme_admin", "super_admin"]);
    const { sessionId } = await w.sessionFor("zone");

    signIn(w.admin);
    const { createRowAction } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
    const created = await createRowAction(
      undefined,
      form({ entitySlug: "rtt-attendance", rttSessionId: sessionId, teacherId: w.teacherId, status: "late" }),
    );
    assert.deepEqual(created, { ok: true }, "a programme admin adds a late mark in the grid");
    const m = await marks(w, sessionId);
    assert.equal(m.get(w.teacherId)?.status, "late");
    assert.equal(m.get(w.teacherId)?.marked_by_user_id, w.admin.id);

    signIn(w.mentor);
    assert.deepEqual(
      await outcome(() =>
        createRowAction(undefined, form({ entitySlug: "rtt-attendance", rttSessionId: sessionId, teacherId: w.sameZone.teacherId, status: "present" })),
      ),
      { kind: "redirect", location: "/forbidden" },
      "a mentor reads the table and writes nothing",
    );
  });
});

// ── in Bhoti ─────────────────────────────────────────────────────────────────

test("/attendance and a session's roster are in Bhoti", { skip }, async () => {
  await withWorld(async (w) => {
    const { sessionId } = await w.sessionFor("zone");
    await save(w.admin, sessionId, { [w.teacherId]: "late" });
    type Bundle = Record<string, Record<string, string>>;
    const bundle = (locale: string): Bundle => JSON.parse(readFileSync(join(SRC_DIR, "i18n", "locales", locale, "rtt.json"), "utf8"));
    const bo = bundle("bo");
    const en = bundle("en");
    const marking = (b: Bundle) => b.marking!;
    const attendance = (b: Bundle) => b.attendance!;

    request.locale = "bo";
    const html = text(await sessionHtml(w.admin, sessionId));
    for (const [label, local, english] of [
      ["the save button", marking(bo).save, marking(en).save],
      ["mark all present", marking(bo).allPresent, marking(en).allPresent],
      ["late", attendance(bo).late, attendance(en).late],
      ["not marked", marking(bo).notMarked, marking(en).notMarked],
    ] as const) {
      assert.ok(html.includes(local!), `${label}: ${local}`);
      assert.ok(!html.includes(english!), `${label}: no English "${english}"`);
    }
    const list = await listHtml(w.admin);
    assert.equal(list.kind, "returned");
    const listText = text(String((list as { value: unknown }).value));
    assert.ok(listText.includes(marking(bo).listTitle!));
    assert.ok(!listText.includes(marking(en).intro!));
  });
});

// ── at phone width ───────────────────────────────────────────────────────────

test("/attendance and a session's roster fit a phone: one column, rows that wrap", { skip }, async () => {
  const { phoneLayoutIssues } = await import("./_phone-layout.js");
  await withWorld(async (w) => {
    const { sessionId } = await w.sessionFor("district");
    await save(w.admin, sessionId, { [w.teacherId]: "late" });
    const list = await listHtml(w.admin);
    assert.equal(list.kind, "returned");
    assert.deepEqual(await phoneLayoutIssues(String((list as { value: unknown }).value)), [], "the list");
    assert.deepEqual(await phoneLayoutIssues(await sessionHtml(w.admin, sessionId, { saved: "1" })), [], "the roster");
  });
});
