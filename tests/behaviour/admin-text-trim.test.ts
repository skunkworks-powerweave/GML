// Names are stored as the person means them, not with the spaces they typed.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// The admin grid and the CSV import stored text exactly as typed: " Tsering
// Dolma " was a different school, teacher or student from "Tsering Dolma" --
// it sorted apart, missed a search, and slipped past a duplicate check that
// compares the stored text. Spreadsheets pad cells with spaces all the time.
// (Found in the 5 Oct 2026 QA of the admin flows.)
//
// ── WHAT IS EXECUTED ───────────────────────────────────────────────────────
//
// The one coercion the grid's create and update and the CSV import share
// (admin/zod-shape.ts coerceFormValues), then the real create and update
// actions and the real importCsv against Postgres. Leading and trailing
// whitespace goes; spaces inside a value stay (a school may be "Govt.  High"
// on purpose, and free text keeps its words), and an empty cell is exactly
// what it was: an untouched field on a new row, a cleared one on an edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, type Fixture } from "./_admin-fixture.js";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { coerceFormValues, unwrapShape } from "../../apps/web/src/admin/zod-shape.ts";

const skip = needsDatabase();
const actions = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
const csvModule = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");

/** What the grid hands zod for `values`, on a create or (emptyMeansNull) an edit. */
function coerced(slug: string, values: Record<string, string>, emptyMeansNull = false): Record<string, unknown> {
  const entity = ADMIN_ENTITIES[slug]!;
  return coerceFormValues(entity.formFields, unwrapShape(entity.formSchema), (f) => values[f] ?? null, { emptyMeansNull });
}

test("text loses its leading and trailing whitespace, and keeps the spaces inside", () => {
  const out = coerced("schools", {
    name: "  Govt.   High School \t",
    address: "\n Main Road, Leh  ",
    headTeacherName: "  Tashi  ",
  });
  assert.equal(out.name, "Govt.   High School", "inner runs of spaces are not collapsed");
  assert.equal(out.address, "Main Road, Leh");
  assert.equal(out.headTeacherName, "Tashi");
});

test("a value that is only whitespace is an empty one: untouched on a new row, cleared on an edit", () => {
  // An empty cell is skipped on create and is null on an edit where the column
  // takes null. Whitespace alone used to be stored as a blank "name".
  assert.equal("address" in coerced("schools", { name: "A School", address: "   " }), false, "create: skipped, as an empty cell is");
  assert.equal("address" in coerced("schools", { name: "A School", address: "" }), false, "create: an empty cell is unchanged");
  assert.equal(coerced("schools", { address: "   " }, true).address, null, "edit: cleared");
  assert.equal(coerced("schools", { address: "" }, true).address, null, "edit: an empty cell still clears");
  // A required text field that is only spaces is "required", not a stored blank.
  assert.equal("name" in coerced("schools", { name: "   " }, true), false, "edit: a required field is left for zod to refuse");
  const refused = ADMIN_ENTITIES.schools!.formSchema.safeParse(coerced("schools", { name: "   ", zoneId: "x" }));
  assert.equal(refused.success, false);
});

test("lists, numbers, booleans and choices are read around their padding as before", () => {
  assert.deepEqual(coerced("mentors", { name: "Asha Rao", expertiseAreas: " phonics ,  numeracy " }).expertiseAreas, ["phonics", "numeracy"]);
  assert.equal(coerced("classes", { grade: " 5 " }).grade, 5);
  assert.equal(coerced("schools", { active: " TRUE " }).active, true);
  assert.equal(coerced("session-attendance", { status: " late " }).status, "late", "a padded choice is the choice");
});

async function geography(f: Fixture, t: string) {
  const district = await f.row("districts", { name: `Dist ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
  return { district, zone };
}

test("the grid's Add row and Edit row store trimmed text", { skip }, async () => {
  const { createRowAction, updateRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("trim-form");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      f.defer(`DELETE FROM schools WHERE zone_id = $1`, [g.zone]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const created = await createRowAction(
        undefined,
        form({
          entitySlug: "schools",
          name: `  Padded School ${t}  `,
          code: ` ${t.slice(-10)} `,
          zoneId: g.zone,
          address: "  Main Road  ",
          contactPhone: "   ",
        }),
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      const { rows } = await c.query(`SELECT id, name, code, address, contact_phone FROM schools WHERE zone_id = $1`, [g.zone]);
      assert.equal(rows.length, 1);
      assert.deepEqual(
        { name: rows[0].name, code: rows[0].code, address: rows[0].address, phone: rows[0].contact_phone },
        { name: `Padded School ${t}`, code: t.slice(-10), address: "Main Road", phone: null },
      );

      const updated = await updateRowAction(
        undefined,
        form({
          entitySlug: "schools",
          rowId: rows[0].id,
          name: `  Renamed School ${t}  `,
          code: t.slice(-10),
          zoneId: g.zone,
          address: "   ",
        }),
      );
      assert.equal(updated.ok, true, JSON.stringify(updated));
      const after = (await c.query(`SELECT name, address FROM schools WHERE id = $1`, [rows[0].id])).rows[0];
      assert.equal(after.name, `Renamed School ${t}`);
      assert.equal(after.address, null, "an address of spaces clears it, as an empty box does");
    } finally {
      await f.cleanup();
    }
  });
});

test("a CSV import stores trimmed text, and the duplicate check sees the trimmed name", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("trim-csv");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      const school = await f.row("schools", { zone_id: g.zone, name: `Valley ${t}`, code: t.slice(-12) });
      f.defer(`DELETE FROM teachers WHERE school_id = $1`, [school]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const padded = ["fullName,schoolId,phone", `"  Tsering   Dolma ${t}  ",${school},  9876543210 `].join("\n");
      const first = await importCsv("teachers", padded);
      assert.equal(first.inserted, 1, JSON.stringify(first));
      const stored = (await c.query(`SELECT full_name, phone FROM teachers WHERE school_id = $1`, [school])).rows;
      assert.deepEqual(stored, [{ full_name: `Tsering   Dolma ${t}`, phone: "9876543210" }]);

      // The same person, typed without the padding: already on the table.
      const again = await importCsv("teachers", ["fullName,schoolId,phone", `Tsering Dolma ${t},${school},9876543210`].join("\n"));
      assert.equal(again.inserted, 0, JSON.stringify(again));
      assert.equal(again.errors.length, 1);
      assert.match(again.errors[0]!.message, /already on this table/);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM teachers WHERE school_id = $1`, [school])).rows[0].n, 1);
    } finally {
      await f.cleanup();
    }
  });
});
