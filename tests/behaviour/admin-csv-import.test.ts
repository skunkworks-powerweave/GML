// CSV import does what its panel promises: every row is judged on its own,
// the good rows land, and each bad one is named by its spreadsheet line.
//
// ── THE DEFECTS ──────────────────────────────────────────────────────────────
//
// F66  importCsv ran ONE multi-row INSERT for the whole file. A single
//      duplicate code or unknown parent id aborted every row, and the result
//      replaced the per-row validation errors with one "bulk_insert failed:
//      <raw driver text>" at row -1 -- naming constraints, and no row. A file
//      over Postgres' 65,535 bind parameters (about 6,500 learners) always
//      failed with "bind message has N parameter formats but 0 parameters".
//      Excel's TRUE/FALSE was "Expected boolean". The route read an unbounded
//      body. createRowAction showed raw driver text too.
// F68  importCsv had its own coercion (true/false only), so array columns
//      (mentor expertiseAreas, resource tags) were "Expected array, received
//      string" in every format -- including the mentors export's own JSON.
// (F74, the panel adding 2 to those line numbers, is admin-csv-import-panel.test.ts.)
//
// Executed: the real importCsv, import route handler and createRowAction, as
// a super_admin, against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const csvModule = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");

async function zone(f: Fixture, t: string): Promise<string> {
  const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
  return f.row("zones", { district_id: district, name: `Z ${t}` });
}

test("one bad row does not sink the file: the rest land and each failure names its line", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("imp-rows");
    const f = fixture(c, t);
    try {
      const z = await zone(f, t);
      const code = (s: string) => `${t.slice(-8)}${s}`;
      await f.row("schools", { zone_id: z, name: `Existing ${t}`, code: code("x") });
      f.defer(`DELETE FROM schools WHERE code LIKE $1`, [`${t.slice(-8)}%`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const csv = [
        "name,code,zoneId,active",
        `Good one ${t},${code("a")},${z},TRUE`, // line 2
        `Dup ${t},${code("x")},${z},TRUE`, // line 3: code already exists
        `,${code("c")},${z},FALSE`, // line 4: no name
        `Orphan ${t},${code("d")},00000000-0000-4000-8000-000000000000,true`, // line 5: no such zone
        `Good two ${t},${code("e")},${z},False`, // line 6
      ].join("\n");
      const r = await importCsv("schools", csv);
      assert.equal(r.inserted, 2, JSON.stringify(r));
      assert.deepEqual(r.errors.map((e) => e.row), [3, 4, 5], JSON.stringify(r.errors));
      for (const e of r.errors) {
        assert.doesNotMatch(e.message, /constraint|schools_|violates|error:/i, `raw driver text reached the operator: ${e.message}`);
      }
      assert.match(r.errors[0]!.message, /code/i, "the duplicate is named by its column");
      assert.match(r.errors[2]!.message, /zoneId/i, "the unknown parent is named by its column");
      const { rows } = await c.query(`SELECT name, active FROM schools WHERE code IN ($1, $2) ORDER BY code`, [code("a"), code("e")]);
      assert.deepEqual(rows, [{ name: `Good one ${t}`, active: true }, { name: `Good two ${t}`, active: false }]);
    } finally {
      await f.cleanup();
    }
  });
});

test("a file larger than one statement's 65,535 parameters imports", { skip, timeout: 180_000 }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("imp-big");
    const f = fixture(c, t);
    try {
      // RTT readings: a table no picker lists, so thousands of rows here do
      // not change what a concurrently running grid test renders.
      const phase = await f.row("phases", { label: `PB ${t}`.slice(0, 24), sequence: 908 });
      const term = await f.row("terms", { phase_id: phase, name: "Term 1", sequence: 1 });
      const subject = await f.row("rtt_subjects", { term_id: term, name: `Big ${t}` });
      f.defer(`DELETE FROM rtt_readings WHERE rtt_subject_id = $1`, [subject]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const lines = ["rttSubjectId,sequence,title,externalUrl"];
      const N = 17_000; // x 4 columns = 68,000 parameters
      for (let i = 0; i < N; i++) lines.push(`${subject},${i % 999},Reading ${i},https://example.org/r/${i}`);
      const r = await importCsv("rtt-readings", lines.join("\n"));
      assert.equal(r.inserted, N, JSON.stringify({ ...r, errors: r.errors.slice(0, 3) }));
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM rtt_readings WHERE rtt_subject_id = $1`, [subject]);
      assert.equal(n.n, N);
    } finally {
      await f.cleanup();
    }
  });
});

test("array columns import from a comma list or a JSON array", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("imp-array");
    const f = fixture(c, t);
    try {
      f.defer(`DELETE FROM mentors WHERE name LIKE $1`, [`% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const csv = `name,expertiseAreas\n"Comma ${t}","English, Maths"\n"Json ${t}","[""Science""]"\n`;
      const r = await importCsv("mentors", csv);
      assert.deepEqual({ inserted: r.inserted, errors: r.errors }, { inserted: 2, errors: [] });
      const { rows } = await c.query(`SELECT name, expertise_areas FROM mentors WHERE name LIKE $1 ORDER BY name`, [`% ${t}`]);
      assert.deepEqual(rows.map((x) => x.expertise_areas), [["English", "Maths"], ["Science"]]);
    } finally {
      await f.cleanup();
    }
  });
});

test("the import route refuses an oversized body with 413", { skip }, async () => {
  const { POST } = await import("../../apps/web/src/app/api/admin/data/[entity]/import/route.ts");
  await withClient(async (c) => {
    const t = tag("imp-cap");
    const f = fixture(c, t);
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const body = "name,code,zoneId\n" + "x".repeat(6 * 1024 * 1024);
      const res = await POST(new Request("http://x/api/admin/data/schools/import", { method: "POST", body }), {
        params: Promise.resolve({ entity: "schools" }),
      });
      assert.equal(res.status, 413);
    } finally {
      await f.cleanup();
    }
  });
});

test("a create that collides with an existing row says so without the driver's text", { skip }, async () => {
  const { createRowAction } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
  await withClient(async (c) => {
    const t = tag("imp-create");
    const f = fixture(c, t);
    try {
      const z = await zone(f, t);
      await f.row("schools", { zone_id: z, name: `First ${t}`, code: t.slice(-12) });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const r = await createRowAction(undefined, form({ entitySlug: "schools", name: `Second ${t}`, code: t.slice(-12), zoneId: z }));
      assert.equal(r.ok, false);
      assert.doesNotMatch(r.error ?? "", /constraint|schools_code_unique|violates|error:/i, r.error);
      assert.match(r.error ?? "", /already exists|duplicate|conflicts/i);
    } finally {
      await f.cleanup();
    }
  });
});
