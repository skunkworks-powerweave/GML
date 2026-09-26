// After a refused save, the admin row form shows what the operator typed.
//
// ── THE DEFECT (FR-03) ───────────────────────────────────────────────────────
//
// A create or update that failed validation echoed the submission back to the
// form as `String(v)` of the COERCED values, so a date came back as
// String(new Date(...)) -- "Thu Oct 01 2026 05:30:00 GMT+0530 (India Standard
// Time)". RowForm used that as the defaultValue of an <input type=date> or
// datetime-local, which the browser's value sanitisation turns into an empty
// box. The operator corrected the field the error was about and saved again:
// the empty optional dates went to the database as NULL with "Row updated.",
// and an empty required date failed "Invalid date". The same echo also put the
// STORED value back into a box the operator had just emptied, so the corrected
// save quietly undid the clearing.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real update/create actions as a programme_admin against Postgres, then
// the real RowForm rendered with the state the action returned (React hands a
// form's useActionState exactly that value once the action settles), then a
// resubmission of what a browser would post from that markup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { React, h, renderSync, openingTags, attr, elements } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form } from "./_admin-fixture.js";

const skip = needsDatabase();
const rowForm = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");
const actions = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

/**
 * Render with `state` as the form's action state: what React passes to
 * useActionState after the action returned it. The hook itself stays React's;
 * only its initial value is the action's result.
 */
function withActionState<T>(state: unknown, body: () => T): T {
  const r = React as unknown as { useActionState: (a: unknown, i: unknown, p?: string) => unknown };
  const real = r.useActionState;
  r.useActionState = (action, _initial, permalink) => real(action, state, permalink);
  try {
    return body();
  } finally {
    r.useActionState = real;
  }
}

/**
 * The HTML value-sanitisation step for the controls this form uses: a date or
 * datetime-local input whose value is not a valid string of its type is EMPTY,
 * and that empty string is what the browser shows and submits.
 */
function sanitised(type: string, value: string): string {
  if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  if (type === "datetime-local") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value) ? value : "";
  if (type === "number") return value.trim() !== "" && Number.isFinite(Number(value)) ? value : "";
  return value;
}

/** What a browser would post from the rendered form, field by field. */
function browserSubmission(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of openingTags(html, "input")) {
    const name = attr(t, "name");
    if (name) out[name] = sanitised(attr(t, "type") ?? "text", attr(t, "value") ?? "");
  }
  for (const s of elements(html, "select")) {
    const name = attr(s.open, "name");
    if (!name) continue;
    const options = elements(s.inner, "option");
    const chosen = options.find((o) => /\sselected=""/.test(o.open)) ?? options[0];
    out[name] = chosen ? (attr(chosen.open, "value") ?? chosen.text) : "";
  }
  for (const a of elements(html, "textarea")) {
    const name = attr(a.open, "name");
    if (name) out[name] = a.text;
  }
  return out;
}

test("FR-03: a refused phase edit keeps its dates, and the corrected save stores them", { skip }, async () => {
  const { RowForm } = await rowForm();
  const { updateRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("form-echo");
    const f = fixture(c, t);
    try {
      const start = new Date("2026-09-30T18:30:00Z"); // 1 October, IST
      const end = new Date("2027-03-31T18:29:59.999Z"); // the last moment of 31 March, IST
      const label = `PE ${t}`.slice(0, 24);
      const phase = await f.row("phases", { label, sequence: 931, start_date: start, end_date: end });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const initialValues = { label, sequence: 931, startDate: start, endDate: end };
      const render = (state: unknown) =>
        withActionState(state, () =>
          renderSync(h(RowForm, { entitySlug: "phases", mode: "edit", rowId: phase, initialValues, options: {} })),
        );

      // The operator opens the row, mistypes the sequence and saves.
      const opened = browserSubmission(render(undefined));
      assert.equal(opened.startDate, "2026-10-01");
      assert.equal(opened.endDate, "2027-03-31");
      const refused = await updateRowAction(undefined, form({ ...opened, sequence: "0" }));
      assert.equal(refused.ok, false);
      assert.ok(refused.fieldErrors?.sequence, "the sequence is what was wrong");
      assert.equal(refused.fields?.startDate, "2026-10-01", "the echo must be what the operator posted");
      assert.equal(refused.fields?.endDate, "2027-03-31");

      // The form as it comes back: the dates are still in their boxes...
      const again = browserSubmission(render(refused));
      assert.equal(again.startDate, "2026-10-01", "the start date box came back empty");
      assert.equal(again.endDate, "2027-03-31", "the end date box came back empty");
      assert.equal(again.sequence, "0", "the mistyped value is shown for correcting");

      // ...so correcting the sequence and saving keeps them.
      const saved = await updateRowAction(undefined, form({ ...again, sequence: "931" }));
      assert.deepEqual(saved, { ok: true });
      const { rows: [row] } = await c.query(`SELECT start_date, end_date FROM phases WHERE id = $1`, [phase]);
      assert.equal((row.start_date as Date | null)?.toISOString(), start.toISOString(), "the corrected save cleared the start date");
      assert.equal((row.end_date as Date | null)?.toISOString(), end.toISOString(), "the corrected save cleared the end date");

      // A box the operator EMPTIED stays empty through a refusal elsewhere, so
      // the corrected save clears it as she asked.
      const cleared = await updateRowAction(undefined, form({ ...again, sequence: "0", endDate: "" }));
      assert.equal(cleared.ok, false);
      const shown = browserSubmission(render(cleared));
      assert.equal(shown.endDate, "", "the stored end date was put back into the box she emptied");
      assert.deepEqual(await updateRowAction(undefined, form({ ...shown, sequence: "931" })), { ok: true });
      const { rows: [after] } = await c.query(`SELECT end_date FROM phases WHERE id = $1`, [phase]);
      assert.equal(after.end_date, null, "the clearing was undone by the refusal");
    } finally {
      await f.cleanup();
    }
  });
});

test("FR-03: a refused add keeps a date-and-time exactly as typed", { skip }, async () => {
  const { RowForm } = await rowForm();
  const { createRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("form-echo-add");
    const f = fixture(c, t);
    try {
      const phase = await f.row("phases", { label: `PA ${t}`.slice(0, 24), sequence: 932 });
      const term = await f.row("terms", { phase_id: phase, name: "Term 1", sequence: 1 });
      const subject = await f.row("rtt_subjects", { term_id: term, name: `RS ${t}` });
      f.defer(`DELETE FROM rtt_sessions WHERE rtt_subject_id = $1`, [subject]);
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");

      // A one-letter title is refused (min 2); the schedule was fine.
      const typed = { entitySlug: "rtt-sessions", rttSubjectId: subject, sequence: "1", title: "W", type: "webinar", scheduledAt: "2026-10-01T10:30" };
      const refused = await createRowAction(undefined, form(typed));
      assert.equal(refused.ok, false);
      assert.ok(refused.fieldErrors?.title);
      assert.equal(refused.fields?.scheduledAt, "2026-10-01T10:30");

      const shown = browserSubmission(
        withActionState(refused, () => renderSync(h(RowForm, { entitySlug: "rtt-sessions", options: {} }))),
      );
      assert.equal(shown.scheduledAt, "2026-10-01T10:30", "the schedule box came back empty");
      assert.deepEqual(await createRowAction(undefined, form({ ...shown, title: `Webinar ${t}` })), { ok: true });
      const { rows } = await c.query(`SELECT scheduled_at FROM rtt_sessions WHERE rtt_subject_id = $1`, [subject]);
      assert.equal(rows.length, 1);
      assert.equal((rows[0].scheduled_at as Date).toISOString(), "2026-10-01T05:00:00.000Z");
    } finally {
      await f.cleanup();
    }
  });
});
