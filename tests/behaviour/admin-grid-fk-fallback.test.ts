// Past the picker limit, the admin grid says where a row's id can be found,
// and shows it.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// A foreign key whose target has more than REF_OPTION_LIMIT rows falls back
// to a UUID box: "Too many rows to list here: paste the id from that table's
// grid". But the grid shows every link by its label and never shows an id --
// not in a cell, not in the edit panel -- so the hint sent the operator to
// look for something that is not there. The filter bar's fallback was a
// "contains…" box that accepts only a whole UUID and then answered "pick a
// value from the list", for a column that has no list.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real grid page for rtt-attendance, whose Session picker is pushed past
// the limit with REF_OPTION_LIMIT + 1 RTT sessions, rendered as a
// super_admin against Postgres; and the real RowForm.

import { test } from "node:test";
import { randomInt } from "node:crypto";
import assert from "node:assert/strict";
import { h, render, renderSync, withAppRouter, request, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const APP = "../../apps/web/src/app/(authenticated)/admin/data/[entity]";

const OLD_HINT = /paste the id from that table.s grid/;
const NEW_HINT = /paste the row.s id: it is shown at the top of that row.s Edit panel/;

test("the UUID box's hint says where the row's id is shown", async () => {
  const { RowForm } = await import(`${APP}/row-form.tsx`);
  const html = decodeEntities(renderSync(h(RowForm, { entitySlug: "outline-lessons", mode: "create", options: { outlineId: null } })));
  assert.doesNotMatch(html, OLD_HINT, "the grid shows no ids to paste");
  assert.match(html, NEW_HINT);
});

test("past the picker limit, the grid's edit panel shows the row id and the filter asks for one", { skip }, async () => {
  const { default: AdminGridPage } = await import(`${APP}/page.tsx`);
  const { REF_OPTION_LIMIT } = await import("../../apps/web/src/admin/references.ts");
  await withClient(async (c) => {
    const t = tag("grid-fk-many");
    const f = fixture(c, t);
    try {
      // One RTT subject with REF_OPTION_LIMIT + 1 sessions: the attendance
      // grid's Session picker is past the limit, and nothing else lists
      // this subject's sessions.
      const phase = await f.row("phases", { label: t.slice(-24), sequence: 1_000_000 + randomInt(1_000_000_000) });
      const term = await f.row("terms", { phase_id: phase, name: `Term ${t}`, sequence: 1 });
      const subject = await f.row("rtt_subjects", { term_id: term, name: `RS ${t}` });
      f.defer(`DELETE FROM rtt_sessions WHERE rtt_subject_id = $1`, [subject]);
      await c.query(
        `INSERT INTO rtt_sessions (rtt_subject_id, sequence, title) SELECT $1, n, 'Webinar ' || n || ' ' || $2 FROM generate_series(1, $3) n`,
        [subject, t, REF_OPTION_LIMIT + 1],
      );
      const { rows: [session] } = await c.query(`SELECT id FROM rtt_sessions WHERE rtt_subject_id = $1 AND sequence = 1`, [subject]);
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      const mark = await f.row("rtt_attendance", { rtt_session_id: session.id, teacher_id: teacher, status: "present" });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      request.cookies = { "gml-device": "desktop" };
      const grid = async (searchParams: Record<string, string>) =>
        decodeEntities(
          await render(
            withAppRouter(
              await AdminGridPage({ params: Promise.resolve({ entity: "rtt-attendance" }), searchParams: Promise.resolve(searchParams) }),
            ),
          ),
        );

      // The form fell back to a UUID box; its hint names a place the id is.
      const plain = await grid({});
      assert.ok(openingTags(plain, "input").some((i) => attr(i, "name") === "rttSessionId"), "the session picker is past the limit");
      assert.doesNotMatch(plain, OLD_HINT);
      assert.match(plain, NEW_HINT);

      // ...and that place shows it, in full, ready to copy.
      const editing = await grid({ edit: mark });
      const shown = /data-testid="edit-row-id"[^>]*>([^<]*)</.exec(editing)?.[1];
      assert.equal(shown, mark, "the edit panel shows the row's id");

      // The filter bar's fallback asks for an id, and says so when given a name.
      const box = openingTags(plain, "input").find((i) => attr(i, "name") === "filter[rttSessionId]");
      assert.ok(box, "the session filter is a text box past the limit");
      assert.match(attr(box, "placeholder") ?? "", /id/, `placeholder: ${attr(box, "placeholder")}`);
      const named = await grid({ "filter[rttSessionId]": "Webinar 1" });
      const note = /data-testid="grid-filters-skipped"[^>]*>([\s\S]*?)<\/p>/.exec(named)?.[1]?.replace(/<[^>]*>/g, "") ?? "";
      assert.doesNotMatch(note, /pick a value from the list/, "there is no list to pick from");
      assert.match(note, /paste the row.s id/, `the note said: ${note}`);
    } finally {
      await f.cleanup();
    }
  });
});
