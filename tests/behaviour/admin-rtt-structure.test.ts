// Districts, RTT phases and terms can be created and corrected from the grid.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The RTT hierarchy is district > zone and phase > term > subject, and the only
// INSERT into districts, phases or terms anywhere in the repository was the
// seed. The seed's Phase 3 ends on 2026-09-30 and has only "Term 1". The
// dashboard derives "the current phase" from those dates, so from October it
// names none; no screen could add Phase 4 or a second term, correct a date, or
// add a district; rtt-subjects needs a termId, so no new subject could be
// attached to anything but the five seeded terms; and the teachers form told
// the operator to "copy the id from /admin/data/phases", which was a 404.
//
// Executed through the grid's real createRowAction / deleteRowAction as a real
// programme_admin, against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, redirectOf } from "./_admin-fixture.js";
import { parseSubmission } from "./_admin-submit.ts";

const skip = needsDatabase();

const actions = () =>
  import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

test("districts, phases and terms are admin entities that programme admins may write", () => {
  for (const slug of ["districts", "phases", "terms"]) {
    const e = ADMIN_ENTITIES[slug];
    assert.ok(e, `/admin/data/${slug} must exist`);
    assert.deepEqual([...(e.mutateRoles ?? e.readRoles)].sort(), ["programme_admin", "super_admin"]);
  }
});

test("a phase cannot end before it starts", () => {
  const bad = parseSubmission("phases", {
    label: "Phase 4",
    sequence: "4",
    startDate: "2026-10-01",
    endDate: "2026-09-01",
  });
  assert.equal(bad.success, false, "an end date before the start date was accepted");
  const ok = parseSubmission("phases", {
    label: "Phase 4",
    sequence: "4",
    startDate: "2026-10-01",
    endDate: "2027-03-31",
  });
  assert.equal(ok.success, true, JSON.stringify(ok.success ? null : ok.error.issues));
});

test("from the grid alone, an admin can open Phase 4, give it a term, and attach an RTT subject", { skip }, async () => {
  const { createRowAction, deleteRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("rtt-structure");
    const f = fixture(c, t);
    const label = `P4 ${t}`.slice(0, 24);
    try {
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      // Registered for cleanup up front, children before parents.
      f.defer(`DELETE FROM phases WHERE label = $1`, [label]);
      f.defer(`DELETE FROM terms WHERE phase_id IN (SELECT id FROM phases WHERE label = $1)`, [label]);
      f.defer(
        `DELETE FROM rtt_subjects WHERE term_id IN (SELECT t.id FROM terms t JOIN phases p ON p.id = t.phase_id WHERE p.label = $1)`,
        [label],
      );
      f.defer(`DELETE FROM districts WHERE code = $1`, [t.slice(-12)]);

      const phase = await createRowAction(
        undefined,
        form({ entitySlug: "phases", label, sequence: "904", startDate: "2026-10-01", endDate: "2027-03-31" }),
      );
      assert.deepEqual(phase, { ok: true });
      const { rows: [p] } = await c.query(`SELECT id, end_date FROM phases WHERE label = $1`, [label]);
      assert.ok(p, "the phase row was written");

      const term = await createRowAction(
        undefined,
        form({ entitySlug: "terms", phaseId: p.id, name: "Term 1", sequence: "1" }),
      );
      assert.deepEqual(term, { ok: true });
      const { rows: [tm] } = await c.query(`SELECT id FROM terms WHERE phase_id = $1`, [p.id]);

      const subject = await createRowAction(
        undefined,
        form({ entitySlug: "rtt-subjects", name: `Subject ${t}`, termId: tm.id, active: "true" }),
      );
      assert.deepEqual(subject, { ok: true });

      const district = await createRowAction(
        undefined,
        form({ entitySlug: "districts", name: `District ${t}`, code: t.slice(-12) }),
      );
      assert.deepEqual(district, { ok: true });

      // Deleting the phase must not take the term and its subject with it.
      const where = await redirectOf(deleteRowAction(form({ entitySlug: "phases", rowId: p.id })));
      assert.match(where ?? "", /error=still_referenced/);
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM terms WHERE phase_id = $1`, [p.id]);
      assert.equal(n.n, 1);
    } finally {
      await f.cleanup();
    }
  });
});

test("the database refuses a phase that ends before it starts, and a duplicate term sequence", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("rtt-constraints");
    await c.query("BEGIN");
    try {
      await assert.rejects(
        c.query(`INSERT INTO phases (label, sequence, start_date, end_date) VALUES ($1, 905, '2026-10-01', '2026-01-01')`, [
          `PX ${t}`.slice(0, 24),
        ]),
        /check constraint/i,
      );
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      const { rows: [p] } = await c.query(
        `INSERT INTO phases (label, sequence) VALUES ($1, 906) RETURNING id`,
        [`PY ${t}`.slice(0, 24)],
      );
      await c.query(`INSERT INTO terms (phase_id, name, sequence) VALUES ($1, 'Term 1', 1)`, [p.id]);
      await assert.rejects(
        c.query(`INSERT INTO terms (phase_id, name, sequence) VALUES ($1, 'Term one again', 1)`, [p.id]),
        /duplicate key|unique/i,
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

// ── THE LAST DAY OF A PHASE IS PART OF IT ────────────────────────────────────
//
// A phase's dates are entered as calendar days and were stored as IST
// midnight at the START of the chosen day. The dashboard names the phase with
// `startDate <= now() AND endDate >= now()`, so a phase entered as ending on
// 31 March stopped being current at 00:00 IST on 31 March: for the whole last
// day of every phase entered through the grid, the dashboard named none.
//
// Executed: the grid's createRowAction and the CSV import, then the
// dashboard's own condition (dashboard/page.tsx) evaluated at chosen instants.
test("a phase is current for the whole of its last day, from the grid and from a CSV", { skip }, async () => {
  const { createRowAction } = await actions();
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("phase-last-day");
    const f = fixture(c, t);
    const typed = `PL ${t}`.slice(0, 24);
    const imported = `PC ${t}`.slice(0, 24);
    try {
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      f.defer(`DELETE FROM phases WHERE label IN ($1, $2)`, [typed, imported]);
      assert.deepEqual(
        await createRowAction(
          undefined,
          form({ entitySlug: "phases", label: typed, sequence: "921", startDate: "2027-01-01", endDate: "2027-03-31" }),
        ),
        { ok: true },
      );
      const csv = await importCsv("phases", `label,sequence,startDate,endDate\n${imported},922,2027-04-01,2027-06-30\n`);
      assert.deepEqual({ inserted: csv.inserted, errors: csv.errors }, { inserted: 1, errors: [] });

      // dashboard/page.tsx: isNotNull(startDate), startDate <= now,
      // endDate IS NULL OR endDate >= now.
      const currentAt = async (label: string, at: string) =>
        (
          await c.query(
            `SELECT 1 FROM phases WHERE label = $1 AND start_date IS NOT NULL AND start_date <= $2
               AND (end_date IS NULL OR end_date >= $2)`,
            [label, at],
          )
        ).rowCount === 1;
      assert.equal(await currentAt(typed, "2027-01-01T00:00:00+05:30"), true, "current from the first minute of its first day");
      assert.equal(await currentAt(typed, "2027-03-31T09:00:00+05:30"), true, "a phase ending on 31 March must be current that morning");
      assert.equal(await currentAt(typed, "2027-03-31T23:59:00+05:30"), true, "and until the day is over");
      assert.equal(await currentAt(typed, "2027-04-01T00:00:00+05:30"), false, "and not the next day");
      assert.equal(await currentAt(imported, "2027-06-30T18:00:00+05:30"), true, "the same from a CSV import");

      // The end date is still read strictly (admin/dates.ts), not by JS Date.
      const ambiguous = parseSubmission("phases", { label: "x", sequence: "1", startDate: "2027-01-01", endDate: "03/31/2027" });
      assert.equal(ambiguous.success, false, "an end date of 03/31/2027 was accepted");

      // The edit form still shows the day that was entered.
      const { toInputValue } = await import("../../apps/web/src/admin/zod-shape.ts");
      const { rows: [p] } = await c.query(`SELECT end_date FROM phases WHERE label = $1`, [typed]);
      assert.equal(toInputValue("date", p.end_date, "date"), "2027-03-31");
    } finally {
      await f.cleanup();
    }
  });
});
