// Editing a row keeps its date and time, and a required date cannot be erased.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// toInputValue rendered every Date as toISOString().slice(0, 10) into a plain
// text box, so opening ANY row and saving it -- even after changing only the
// title -- posted "2026-10-01", which z.coerce.date turned into midnight UTC:
// every RTT webinar, observation schedule and pairing start silently moved to
// 05:30 IST on its first edit. Clearing a required date sent null, and
// z.coerce.date(null) is new Date(0), so the row was saved as 1 January 1970
// and the form said "Row updated." Free text went through JS Date, which reads
// 05/10/2026 as 10 May.
//
// Executed: the real RowForm rendered, and the real update/create actions as a
// programme_admin against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, renderSync, openingTags, attr } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form } from "./_admin-fixture.js";

const skip = needsDatabase();
const rowForm = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");
const actions = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

const input = (html: string, name: string) => openingTags(html, "input").find((t) => attr(t, "name") === name);

test("a timestamp is edited as a local date AND time, in the programme's timezone", async () => {
  const { RowForm } = await rowForm();
  const html = renderSync(
    h(RowForm, {
      entitySlug: "rtt-sessions",
      mode: "edit",
      rowId: "33333333-3333-4333-8333-333333333333",
      initialValues: { title: "Webinar", scheduledAt: new Date("2026-10-01T05:00:00Z") },
      options: {},
    }),
  );
  const box = input(html, "scheduledAt");
  assert.ok(box, "scheduledAt input");
  assert.equal(attr(box, "type"), "datetime-local", "a timestamp needs a date-and-time control");
  assert.equal(attr(box, "value"), "2026-10-01T10:30", "05:00 UTC is 10:30 in Ladakh; the time must survive");
});

test("a phase's dates are date pickers", async () => {
  const { RowForm } = await rowForm();
  const html = renderSync(
    h(RowForm, {
      entitySlug: "phases",
      mode: "edit",
      rowId: "33333333-3333-4333-8333-333333333333",
      initialValues: { label: "Phase 4", sequence: 4, startDate: new Date("2026-09-30T18:30:00Z") },
    }),
  );
  const box = input(html, "startDate");
  assert.equal(attr(box ?? "", "type"), "date");
  assert.equal(attr(box ?? "", "value"), "2026-10-01", "IST midnight on 1 October is 1 October");
});

test("saving an edit keeps the time, and clearing a required date is refused", { skip }, async () => {
  const { updateRowAction, createRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("grid-dates");
    const f = fixture(c, t);
    try {
      const phase = await f.row("phases", { label: `PD ${t}`.slice(0, 24), sequence: 907 });
      const term = await f.row("terms", { phase_id: phase, name: "Term 1", sequence: 1 });
      const subject = await f.row("rtt_subjects", { term_id: term, name: `RS ${t}` });
      const session = await f.row("rtt_sessions", {
        rtt_subject_id: subject,
        sequence: 1,
        title: `Webinar ${t}`,
        type: "webinar",
        scheduled_at: new Date("2026-10-01T05:00:00Z"),
      });
      f.defer(`DELETE FROM rtt_sessions WHERE rtt_subject_id = $1`, [subject]);
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");

      // What the edit form now posts back for an untouched datetime-local box.
      const saved = await updateRowAction(
        undefined,
        form({
          entitySlug: "rtt-sessions",
          rowId: session,
          rttSubjectId: subject,
          sequence: "1",
          title: `Renamed ${t}`,
          type: "webinar",
          scheduledAt: "2026-10-01T10:30",
        }),
      );
      assert.deepEqual(saved, { ok: true });
      const { rows: [s] } = await c.query(`SELECT scheduled_at FROM rtt_sessions WHERE id = $1`, [session]);
      assert.equal((s.scheduled_at as Date).toISOString(), "2026-10-01T05:00:00.000Z");

      const phaseEdit = await updateRowAction(
        undefined,
        form({ entitySlug: "phases", rowId: phase, label: `PD ${t}`.slice(0, 24), sequence: "907", startDate: "" }),
      );
      assert.deepEqual(phaseEdit, { ok: true }, "an OPTIONAL date may be cleared");

      const ambiguous = await createRowAction(
        undefined,
        form({ entitySlug: "rtt-sessions", rttSubjectId: subject, sequence: "2", title: `Amb ${t}`, type: "webinar", scheduledAt: "05/10/2026" }),
      );
      assert.equal(ambiguous.ok, false, "05/10/2026 must not be stored as 10 May");
      assert.ok(ambiguous.fieldErrors?.scheduledAt);
    } finally {
      await f.cleanup();
    }
  });
});

test("clearing an observation cycle's required schedule does not save 1970", { skip }, async () => {
  const { updateRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("grid-dates-req");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      const observer = await f.user("observer", "observer");
      const admin = await f.user("programme_admin", "padmin");
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "observation", expires_at: new Date(Date.now() + 3600_000) });
      const cycle = await f.row("observation_cycles", {
        code: `OBS-${t}`,
        teacher_id: teacher,
        observer_id: observer,
        kind: "baseline",
        status: "nominated",
        scheduled_at: new Date("2026-10-15T04:30:00Z"),
      });
      actAs(admin, "programme_admin");
      const r = await updateRowAction(
        undefined,
        form({ entitySlug: "observation-cycles", rowId: cycle, code: `OBS-${t}`, teacherId: teacher, observerId: observer, kind: "baseline", scheduledAt: "" }),
      );
      assert.equal(r.ok, false, "clearing a required date reported success");
      assert.ok(r.fieldErrors?.scheduledAt);
      const { rows: [row] } = await c.query(`SELECT scheduled_at FROM observation_cycles WHERE id = $1`, [cycle]);
      assert.equal((row.scheduled_at as Date).toISOString(), "2026-10-15T04:30:00.000Z");
    } finally {
      await f.cleanup();
    }
  });
});

// ── SECONDS SURVIVE AN UNTOUCHED EDIT ────────────────────────────────────────
//
// A datetime-local box shows minutes, so a stored timestamp with seconds
// (mentor_pairings.startedAt defaults to now()) came back from an untouched
// edit form truncated to the minute: the row's time changed on every save,
// and the audit diff recorded a startedAt change nobody made.
test("an untouched edit keeps a timestamp's seconds and audits no change to it", { skip }, async () => {
  const { RowForm } = await rowForm();
  const { updateRowAction } = await actions();
  const { h: el, renderSync: draw } = await import("./_ui.js");
  await withClient(async (c) => {
    const t = tag("grid-dates-sec");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      const mentor = await f.row("mentors", { name: `M ${t}` });
      const started = new Date("2026-09-03T04:31:17.123Z");
      const pairing = await f.row("mentor_pairings", { mentor_id: mentor, teacher_id: teacher, started_at: started });
      const admin = await f.user("programme_admin", "padmin");
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "mentorship", expires_at: new Date(Date.now() + 3600_000) });
      actAs(admin, "programme_admin");

      // The value the edit form shows for it, as rendered.
      const shown = attr(
        input(
          draw(
            el(RowForm, {
              entitySlug: "mentor-pairings",
              mode: "edit",
              rowId: pairing,
              initialValues: { mentorId: mentor, teacherId: teacher, startedAt: started, status: "active" },
              options: {},
            }),
          ),
          "startedAt",
        ) ?? "",
        "value",
      );
      assert.equal(shown, "2026-09-03T10:01");

      const r = await updateRowAction(
        undefined,
        form({ entitySlug: "mentor-pairings", rowId: pairing, mentorId: mentor, teacherId: teacher, startedAt: shown!, status: "active", conceptNote: "Fractions first" }),
      );
      assert.deepEqual(r, { ok: true });
      const { rows: [row] } = await c.query(`SELECT started_at, concept_note FROM mentor_pairings WHERE id = $1`, [pairing]);
      assert.equal(row.concept_note, "Fractions first");
      assert.equal((row.started_at as Date).toISOString(), started.toISOString(), "saving the form cut the seconds off startedAt");

      let meta: Record<string, unknown> | undefined;
      for (let i = 0; i < 40 && !meta; i++) {
        const { rows: audit } = await c.query(
          `SELECT metadata FROM audit_log WHERE action = 'admin.row.update' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [pairing],
        );
        meta = audit[0]?.metadata;
        if (!meta) await new Promise((res) => setTimeout(res, 50));
      }
      assert.deepEqual(Object.keys((meta?.changes as object) ?? {}), ["conceptNote"], "only the note changed");
    } finally {
      await f.cleanup();
    }
  });
});
