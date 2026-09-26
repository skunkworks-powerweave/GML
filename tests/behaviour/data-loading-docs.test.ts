// The data-loading instructions, checked against the code they describe.
//
// A fresh deployment's Repository reads Classes 0, Sessions 0, Learners 0,
// Reading material 0, because the seed never writes those tables and the
// documented demo purge empties several more. Nothing distinguished "not loaded
// yet" from "broken", and no operator document mentioned CSV import at all --
// only export. README-deploy.md section 3.2 now does.
//
// These tests hold that section to the code: every table it says is empty must
// have an admin grid to fill it from, every grid it names must exist, and the
// export step it relies on (copy the parent's `id` column into the child CSV)
// must actually produce an `id` column.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { exportColumnKeys } from "../../apps/web/src/admin/export-columns.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function section(md: string, heading: RegExp): string {
  const start = md.search(heading);
  assert.ok(start >= 0, `section ${heading} not found`);
  const rest = md.slice(start + 1);
  const next = rest.search(/\n#{2,3} /);
  return next >= 0 ? md.slice(start, start + 1 + next) : md.slice(start);
}

const deploy = () => section(read("README-deploy.md"), /^### 3\.2 /m);
const registeredTables = () =>
  new Set(Object.values(ADMIN_ENTITIES).map((e) => getTableName(e.table)));

test("README-deploy has a data-loading section that says the empty Repository is expected", () => {
  const s = deploy();
  assert.match(s, /Import CSV/);
  assert.match(s, /Export CSV/);
  assert.match(s, /expected/i);
  assert.match(s, /\/admin\b/);
});

test("every table the docs call empty has an admin grid to load it from", () => {
  const s = deploy();
  const sentence = s.slice(0, s.indexOf("/admin"));
  const named = [...sentence.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
  assert.ok(named.length >= 10, `expected the empty-table list, found ${named.join(", ")}`);
  const tables = registeredTables();
  const unloadable = named.filter((t) => !tables.has(t));
  assert.deepEqual(unloadable, [], "a table documented as 'load it yourself' needs a grid to load it in");
});

test("every grid the load order names exists", () => {
  const s = deploy();
  const slugs = [...s.matchAll(/\*\*([a-z]+(?:-[a-z]+)*)\*\*/g)].map((m) => m[1]!);
  assert.ok(slugs.length >= 10, `expected the load order, found ${slugs.join(", ")}`);
  const missing = slugs.filter((slug) => !(slug in ADMIN_ENTITIES));
  assert.deepEqual(missing, []);
});

test("the export step the docs rely on really yields an id column", () => {
  assert.match(deploy(), /first column is `id`/);
  for (const parent of ["schools", "classes", "teachers", "mentors", "rtt-subjects", "rtt-modules"]) {
    assert.equal(exportColumnKeys(ADMIN_ENTITIES[parent]!)[0], "id", `${parent} export must start with id`);
  }
});

test("README-IT's admin surface list includes the data tables and points at the procedure", () => {
  const it = read("README-IT.md");
  assert.match(it, /\/admin\/data\//);
  assert.match(it, /README-deploy\.md` section 3\.2/);
  assert.match(it, /\/observation\/new/);
});
