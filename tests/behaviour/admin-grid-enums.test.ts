// Saving a grid row keeps every stored enum value it did not change.
//
// ── THE DEFECT (FR-04) ───────────────────────────────────────────────────────
//
// entities/mentor-pairings.ts declared status as z.enum(["active", "paused",
// "ended"]), while the database's pairing_status is active, review, paused,
// ended, complete -- and both are written (the seed sets "review" and
// "complete", the one-click Complete pairing "complete"). The edit form's Status
// <select> had no option for the stored value, so it showed "active"; pressing
// Save to fix a typo in the concept note wrote status=active, reopening a
// finished mentorship. The CSV import refused every review/complete row, and
// the Status filter refused both values.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// Every registered entity's real form schema against its real Drizzle table;
// the real RowForm rendered for stored pairings, and what a browser would post
// from it sent through the real update action to Postgres; the real grid page
// filtered by the values the form used to lack.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { h, renderSync, render, withAppRouter, openingTags, attr, elements, request } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form } from "./_admin-fixture.js";

const skip = needsDatabase();
const rowForm = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");
const actions = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

/** What a browser would post from the rendered form (hidden, text and select controls). */
function browserSubmission(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of openingTags(html, "input")) {
    const name = attr(t, "name");
    if (name) out[name] = attr(t, "value") ?? "";
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

test("FR-04: every enum field in the grid offers exactly the values its database column holds", async () => {
  const { ADMIN_ENTITIES } = await import("../../apps/web/src/admin/registry.ts");
  const { unwrapShape, enumOptions } = await import("../../apps/web/src/admin/zod-shape.ts");
  const checked: string[] = [];
  for (const entity of Object.values(ADMIN_ENTITIES)) {
    const shape = unwrapShape(entity.formSchema);
    const columns = getTableColumns(entity.table as never) as Record<string, { columnType?: string; enumValues?: string[] }>;
    for (const field of entity.formFields) {
      const column = columns[field];
      if (column?.columnType !== "PgEnumColumn") continue;
      checked.push(`${entity.slug}.${field}`);
      assert.deepEqual(
        enumOptions(shape[field]),
        column.enumValues,
        `${entity.slug}.${field}: the form's choices differ from the database enum, so a stored value outside them is overwritten on save`,
      );
    }
  }
  assert.ok(checked.includes("mentor-pairings.status"), `checked: ${checked.join(", ")}`);
});

test("FR-04: saving a review or complete pairing's note from the grid keeps its status", { skip }, async () => {
  const { RowForm } = await rowForm();
  const { updateRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("grid-enum");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      const mentor = await f.row("mentors", { name: `M ${t}` });
      const ended = new Date("2026-09-20T04:30:00Z");
      const admin = await f.user("programme_admin", "padmin");
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "mentorship", expires_at: new Date(Date.now() + 3600_000) });
      actAs(admin, "programme_admin");

      for (const [i, status] of ["review", "complete"].entries()) {
        // One pairing per mentor, mentee and start (mentor_pairings_mentor_teacher_started_uq).
        const started = new Date(Date.UTC(2026, 5, 1 + i, 4, 30));
        const pairing = await f.row("mentor_pairings", {
          mentor_id: mentor,
          teacher_id: teacher,
          started_at: started,
          ended_at: status === "complete" ? ended : null,
          status,
          concept_note: "Fractoins",
        });
        const html = renderSync(
          h(RowForm, {
            entitySlug: "mentor-pairings",
            mode: "edit",
            rowId: pairing,
            initialValues: {
              mentorId: mentor,
              teacherId: teacher,
              startedAt: started,
              endedAt: status === "complete" ? ended : null,
              status,
              conceptNote: "Fractoins",
            },
            options: {},
          }),
        );
        const posted = browserSubmission(html);
        assert.equal(posted.status, status, `the Status control shows "${posted.status}" for a ${status} pairing`);

        // The operator fixes the typo in the note and saves.
        const r = await updateRowAction(undefined, form({ ...posted, conceptNote: "Fractions" }));
        assert.deepEqual(r, { ok: true });
        const { rows: [row] } = await c.query(`SELECT status, concept_note FROM mentor_pairings WHERE id = $1`, [pairing]);
        assert.equal(row.concept_note, "Fractions");
        assert.equal(row.status, status, `saving the note moved a ${status} pairing to "${row.status}"`);
      }

      // A CSV of pairings in either state imports rather than being refused.
      const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
      f.defer(`DELETE FROM mentor_pairings WHERE mentor_id = $1`, [mentor]);
      const imported = await importCsv(
        "mentor-pairings",
        [
          "mentorId,teacherId,startedAt,status",
          `${mentor},${teacher},2026-07-01T10:00,review`,
          `${mentor},${teacher},2026-07-02T10:00,complete`,
        ].join("\n"),
      );
      assert.equal(imported.inserted, 2, `CSV import refused: ${JSON.stringify(imported.errors)}`);

      // The grid's Status filter takes both values rather than skipping them.
      request.cookies = { "gml-device": "desktop" };
      const { default: AdminGridPage } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");
      const grid = await render(
        withAppRouter(
          await AdminGridPage({
            params: Promise.resolve({ entity: "mentor-pairings" }),
            searchParams: Promise.resolve({ "filter[status]": "complete" }),
          }),
        ),
      );
      assert.ok(
        !elements(grid, "p").some((p) => attr(p.open, "data-testid") === "grid-filters-skipped"),
        "the Status filter refused 'complete'",
      );
      const statusCells = elements(grid, "td").map((td) => td.text.trim()).filter((s) => /^(active|review|paused|ended|complete)$/.test(s));
      assert.ok(statusCells.length > 0, "the filtered grid lists the complete pairing");
      assert.ok(statusCells.every((s) => s === "complete"), `filtered by complete, the grid lists: ${statusCells.join(", ")}`);
    } finally {
      await f.cleanup();
    }
  });
});

// A stored value the choices do not include -- a varchar enum written before
// its list was narrowed, or the next drift -- is shown as itself and stays
// selected, so a save either keeps it or is refused; it is never silently
// replaced by the first choice or the default.
test("FR-04: a stored value outside the form's choices is shown selected, not replaced", async () => {
  const { RowForm } = await rowForm();
  const html = renderSync(
    h(RowForm, {
      entitySlug: "sessions",
      mode: "edit",
      rowId: "33333333-3333-4333-8333-333333333333",
      initialValues: { topic: "Fractions", status: "postponed", scheduledDate: "2026-10-01" },
      options: {},
    }),
  );
  assert.equal(browserSubmission(html).status, "postponed");
});
