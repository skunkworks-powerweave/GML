// An export can be edited and imported again: it carries every column the
// import takes.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// The schools export left out "address", which the form and the import both
// accept, so an administrator could not fill addresses in a spreadsheet and load
// them back -- the export had never been compared with the import. The export
// wrote an entity's displayColumns, and nothing said those had to cover the
// form. They did not, for eighteen tables (a mentor's bio and expertise, a
// session's time and duration, a resource's tags and link, a lesson's body ...).
// (Found in the 5 Oct 2026 QA of the admin flows.)
//
// ── THE RULE, FOR EVERY ENTITY ─────────────────────────────────────────────
//
// For every entity in ADMIN_ENTITIES that takes an import: every form field
// the importer reads, and the id that makes a row an update, is a column of
// its export. The two read-only lists (approvals, account requests) take no
// import, so their export keeps to what the grid shows; see
// admin/export-columns.ts.
//
// ── WHAT IS EXECUTED ───────────────────────────────────────────────────────
//
// The registry's own definitions for the rule, and the real export routes
// against Postgres for the two that matter most: the schools export (the
// reported one) and the mentors export, which has a route of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { getTableColumns } from "drizzle-orm";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { exportColumnKeys } from "../../apps/web/src/admin/export-columns.ts";

const skip = needsDatabase();
// papaparse is the web app's dependency, not the repository root's.
const Papa = createRequire(new URL("../../apps/web/package.json", import.meta.url))("papaparse") as {
  parse: <T>(s: string, o: { header: boolean; skipEmptyLines: boolean }) => { data: T[]; meta: { fields?: string[] } };
  unparse: (d: { fields: string[]; data: Record<string, string>[] }) => string;
};
const here = dirname(fileURLToPath(import.meta.url));
const acceptsImport = (slug: string) => (ADMIN_ENTITIES[slug]!.mutateRoles ?? ADMIN_ENTITIES[slug]!.readRoles).length > 0;

test("every entity that takes an import exports every column the import takes", () => {
  const problems: string[] = [];
  let checked = 0;
  for (const [slug, entity] of Object.entries(ADMIN_ENTITIES)) {
    if (!acceptsImport(slug)) continue;
    checked += 1;
    const exported = new Set(exportColumnKeys(entity));
    for (const field of entity.formFields) {
      if (!exported.has(field)) problems.push(`${slug}: the import takes "${field}" but the export has no such column`);
    }
    if ("id" in getTableColumns(entity.table) && !exported.has("id")) problems.push(`${slug}: no id column, so an edited row cannot be matched`);
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 30, `the rule must run against the whole registry, ran against ${checked}`);
});

test("the grid's own columns still come first, in their order, after the id", () => {
  // Operators script against the existing layout: what the export always had
  // keeps its place and the missing form fields follow.
  for (const [slug, entity] of Object.entries(ADMIN_ENTITIES)) {
    const keys = exportColumnKeys(entity);
    const display = entity.displayColumns.map((c) => c.key);
    const lead = keys.filter((k) => k !== "id").slice(0, display.length);
    assert.deepEqual(lead, display, `${slug}: display columns lost their place`);
    assert.equal(new Set(keys).size, keys.length, `${slug}: a column is exported twice`);
  }
});

test("a read-only list exports what its grid shows and no more", () => {
  // Nothing imports into approvals or account requests (mutateRoles is empty),
  // so there is no round trip to serve, and their form-only columns -- an
  // applicant's free-text message, a submitter's note -- are not for a download.
  for (const slug of ["approvals", "account-requests"]) {
    assert.equal(acceptsImport(slug), false, `${slug} is read-only`);
    const keys = exportColumnKeys(ADMIN_ENTITIES[slug]!);
    assert.equal(keys.includes("note") || keys.includes("message"), false, `${slug} exported a form-only text column`);
    assert.deepEqual(
      keys.filter((k) => k !== "id"),
      ADMIN_ENTITIES[slug]!.displayColumns.map((c) => c.key),
    );
  }
});

test("only the generic export route and the mentors one serve an admin table, so the rule covers every export", () => {
  // A table with a route of its own (mentors, for its pairings count) escapes
  // exportColumnKeys unless the route uses it: a new one has to be added here
  // knowingly, with a test like the mentors one below.
  const routes = readdirSync(resolve(here, "../../apps/web/src/app/api/admin/data"));
  assert.deepEqual(routes.sort(), ["[entity]", "mentors"]);
});

test("the schools export carries the address, and an edited export loads back", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("export-address");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `Dist ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
      const school = await f.row("schools", {
        zone_id: zone,
        name: `Hill School ${t}`,
        code: t.slice(-12),
        address: "Main Bazaar, Leh",
      });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const res = await GET(new Request("http://x/api/admin/data/schools/export"), { params: Promise.resolve({ entity: "schools" }) });
      const exported = Papa.parse<Record<string, string>>(await res.text(), { header: true, skipEmptyLines: true });
      assert.ok(exported.meta.fields?.includes("address"), `the schools export has no address column: ${exported.meta.fields}`);
      const mine = exported.data.filter((r) => r.id === school);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]!.address, "Main Bazaar, Leh");

      // Edit the address in the spreadsheet and import the file again.
      mine[0]!.address = "Main Bazaar, Leh 194101";
      const back = await importCsv("schools", Papa.unparse({ fields: Object.keys(mine[0]!), data: mine }));
      assert.deepEqual({ updated: back.updated, inserted: back.inserted, errors: back.errors }, { updated: 1, inserted: 0, errors: [] });
      const { rows } = await c.query(`SELECT address, name FROM schools WHERE id = $1`, [school]);
      assert.deepEqual(rows[0], { address: "Main Bazaar, Leh 194101", name: `Hill School ${t}` });
    } finally {
      await f.cleanup();
    }
  });
});

test("the mentors export, which has its own route, carries every column the mentors import takes", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/data/mentors/export/route.ts");
  await withClient(async (c) => {
    const t = tag("export-mentors");
    const f = fixture(c, t);
    try {
      const mentor = await f.row("mentors", {
        name: `Mentor ${t}`,
        bio: "Twenty years in Leh",
        photo_url: "https://example.test/m.jpg",
        active: false,
        expertise_areas: JSON.stringify(["phonics", "numeracy"]),
      });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const res = await GET(new Request("http://x/api/admin/data/mentors/export"));
      const exported = Papa.parse<Record<string, string>>(await res.text(), { header: true, skipEmptyLines: true });
      const have = new Set(exported.meta.fields);
      const missing = ["id", ...ADMIN_ENTITIES.mentors!.formFields].filter((k) => !have.has(k));
      assert.deepEqual(missing, [], "columns the mentors import takes but its export lacks");
      // The columns operators already script against keep their place.
      assert.deepEqual(exported.meta.fields!.slice(0, 6), ["id", "name", "hindiName", "baseLocation", "expertiseAreas", "pairingsActive"]);
      const row = exported.data.find((r) => r.id === mentor)!;
      assert.equal(row.bio, "Twenty years in Leh");
      assert.equal(row.photoUrl, "https://example.test/m.jpg");
      assert.equal(row.active, "false");
      assert.deepEqual(JSON.parse(row.expertiseAreas!), ["phonics", "numeracy"]);
    } finally {
      await f.cleanup();
    }
  });
});
