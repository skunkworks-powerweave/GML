// A yes/no field in the admin grid's add-row form starts on the entity's own
// default, not on "yes".
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// RowForm's boolean <select> fell back to a hard-coded "true" when it had no
// value (`defaultValue={initial || "true"}`), chosen to suit the `active`
// fields. sessions.observed defaults to false in zod and in the column, but
// the sessions add-row form opened on Observed = yes, so every session added
// from the grid without touching that field was recorded as OBSERVED -- false
// data that the repository's session pages then show as "Observed: Yes". The
// enum branch beside it already read the zod default; booleans did not.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real RowForm rendered to HTML; then what a browser would submit for that
// form, with only the fields an operator must fill filled in, through the real
// createRowAction as a programme_admin, against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, renderSync, elements, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form } from "./_admin-fixture.js";

const skip = needsDatabase();
const rowForm = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");

/** What a browser submits for this form if nothing in it is touched. */
function untouched(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of elements(html, "select")) {
    const name = attr(s.open, "name");
    if (!name) continue;
    const options = openingTags(s.inner, "option");
    const chosen = options.find((o) => /\sselected=""/.test(o)) ?? options[0];
    out[name] = chosen ? (attr(chosen, "value") ?? "") : "";
  }
  for (const i of openingTags(html, "input")) {
    const name = attr(i, "name");
    if (name) out[name] = attr(i, "value") ?? "";
  }
  for (const t of elements(html, "textarea")) {
    const name = attr(t.open, "name");
    if (name) out[name] = decodeEntities(t.inner);
  }
  return out;
}

test("the sessions form starts on Observed = no, and `active` fields on yes", async () => {
  const { RowForm } = await rowForm();
  const sessions = untouched(renderSync(h(RowForm, { entitySlug: "sessions", mode: "create", options: {} })));
  assert.equal(sessions.observed, "false", "a new session must not start out marked observed");
  for (const slug of ["schools", "classes", "teachers"]) {
    const values = untouched(renderSync(h(RowForm, { entitySlug: slug, mode: "create", options: {} })));
    assert.equal(values.active, "true", `a new ${slug} row starts active, as its schema says`);
  }
  // Editing shows what is stored, whichever way it points.
  const stored = untouched(
    renderSync(
      h(RowForm, {
        entitySlug: "sessions",
        mode: "edit",
        rowId: "11111111-1111-4111-8111-111111111111",
        initialValues: { observed: true },
        options: {},
      }),
    ),
  );
  assert.equal(stored.observed, "true");
});

test("a session added from the grid with Observed left alone is stored as not observed", { skip }, async () => {
  const { RowForm } = await rowForm();
  const { createRowAction } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
  await withClient(async (c) => {
    const t = tag("grid-bool");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const subject = await f.row("subjects", { name: `Subj ${t}`, code: `S${t.slice(-6).toUpperCase()}` });
      const klass = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
      const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      f.defer(`DELETE FROM sessions WHERE topic = $1`, [`Topic ${t}`]);
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");

      const html = renderSync(
        h(RowForm, {
          entitySlug: "sessions",
          mode: "create",
          options: {
            schoolId: [{ id: school, label: "School" }],
            classId: [{ id: klass, label: "Class" }],
            subjectId: [{ id: subject, label: "Subject" }],
            teacherId: [{ id: teacher, label: "Teacher" }],
          },
        }),
      );
      // The operator fills what the form marks required, and nothing else.
      const values = {
        ...untouched(html),
        schoolId: school,
        classId: klass,
        subjectId: subject,
        teacherId: teacher,
        scheduledDate: "2026-10-05",
        topic: `Topic ${t}`,
      };
      const r = await createRowAction(undefined, form(values));
      assert.deepEqual(r, { ok: true });
      const { rows } = await c.query(`SELECT observed FROM sessions WHERE topic = $1`, [`Topic ${t}`]);
      assert.deepEqual(rows, [{ observed: false }], "the untouched form recorded the session as observed");
    } finally {
      await f.cleanup();
    }
  });
});
