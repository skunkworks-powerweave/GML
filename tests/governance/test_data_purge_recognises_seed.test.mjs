// The demo-data purge must recognise every fictional row the seed writes.
//
// purge_demo_data.ts does not guess what "looks fake". It matches the seed's
// own literals -- school codes, the teacher phone block, the cycle code prefix,
// the mentor names -- and says so: "If the seed data changes, these change with
// it." Nothing enforced that, and one list had already drifted.
//
// THE DRIFT THIS CAUGHT. The purge deleted mentors named
//     'Dr. Anjali Bhatt', 'Rinchen Angmo'
// but the seed's two mentors are Dr. Anjali Bhatt and Prof. Iqbal Hussain.
// Rinchen Angmo is one of the seed's TEACHERS. So after the documented day-one
// purge, a fictional "Prof. Iqbal Hussain" stayed in the mentor roster, in
// QuickFind and in every admin grid -- the exact outcome README-deploy.md 3.1
// says the purge prevents. Observed on a throwaway database: seed, purge
// --apply, and "Remaining: ... mentors 1".
//
// This reads source text, so it proves the two lists AGREE, not that the
// purge's DELETEs work. tests/behaviour/seed-after-purge.test.ts executes the
// purge for that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SEED = read("packages/db/src/scripts/seed.ts");
const PURGE = read("packages/db/src/scripts/purge_demo_data.ts");

/** The body of `.insert(schema.<table>) ... .returning(` in seed.ts. */
function seedInsertBlock(table) {
  const start = SEED.indexOf(`.insert(schema.${table})`);
  assert.ok(start >= 0, `seed.ts no longer inserts schema.${table}; update this test`);
  const end = SEED.indexOf(".returning(", start);
  return SEED.slice(start, end > start ? end : undefined);
}

const allMatches = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

/** A `const NAME = [ "a", "b" ]` string array declared in purge_demo_data.ts. */
function purgeConstArray(name) {
  const m = PURGE.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  return m ? allMatches(/["']([^"']+)["']/g, m[1]) : null;
}

test("purge recognises every mentor the seed invents", () => {
  const seeded = allMatches(/\bname:\s*"([^"]+)"/g, seedInsertBlock("mentors")).sort();
  assert.ok(seeded.length > 0, "found no mentor names in seed.ts");

  // Either the named constant, or -- the shape it drifted in -- a literal
  // list inside the mentors DELETE.
  let purged = purgeConstArray("DEMO_MENTOR_NAMES");
  if (!purged) {
    const del = PURGE.match(/DELETE FROM mentors[\s\S]*?name IN \(([^)]*)\)/);
    assert.ok(del, "could not find how purge_demo_data.ts recognises demo mentors");
    purged = allMatches(/'([^']+)'/g, del[1]);
  }

  assert.deepEqual(
    [...purged].sort(),
    seeded,
    "purge_demo_data.ts must remove exactly the mentors seed.ts creates -- any seeded " +
      "mentor it misses stays in the live roster as a fictional person after the day-one purge",
  );
});

test("purge recognises every school the seed invents", () => {
  const seeded = allMatches(/\bcode:\s*"([^"]+)"/g, seedInsertBlock("schools")).sort();
  const purged = purgeConstArray("DEMO_SCHOOL_CODES");
  assert.ok(purged, "purge_demo_data.ts must declare DEMO_SCHOOL_CODES");
  assert.deepEqual([...purged].sort(), seeded);
});

// The teacher and cycle recognisers used to be PREFIXES, `+91 94191000%` and
// `OBS-2026-0%`, and these tests only checked that each prefix COVERED the
// seed. That was the wrong invariant: /observation/new mints real codes as
// OBS-<year>-<max+1>, so the cycle prefix also matched every real cycle
// created in 2026, and the day-one purge deleted the nominated ones (F102).
// The recognisers are now the seed's exact literals, pinned in both
// directions: a seeded row the purge missed would stay live, and a literal the
// seed never wrote could only ever match a real row.
// tests/behaviour/seed-after-purge.test.ts runs the purge itself.

test("purge recognises exactly the teachers the seed invents, by their exact mobiles", () => {
  const start = SEED.indexOf("teachersData");
  const block = SEED.slice(start, SEED.indexOf("];", start));
  const phones = allMatches(/\bphone:\s*"([^"]+)"/g, block).sort();
  assert.ok(phones.length > 0, "found no teacher phones in seed.ts");
  const purged = purgeConstArray("DEMO_TEACHER_PHONES");
  assert.ok(purged, "purge_demo_data.ts must declare DEMO_TEACHER_PHONES");
  assert.deepEqual([...purged].sort(), phones);
});

test("purge recognises exactly the seed's OBS-2026-NNN cycle codes, not a prefix", () => {
  assert.match(
    SEED,
    /code:\s*`OBS-2026-\$\{String\(i \+ 1\)\.padStart\(3, "0"\)\}`/,
    "seed.ts cycle codes changed shape; re-check DEMO_CYCLE_CODES",
  );
  const slice = SEED.match(/const cyclesValues = teachersInsert\.slice\(0, (\d+)\)/);
  assert.ok(slice, "seed.ts no longer takes its cycles from teachersInsert.slice(0, N); update this test");
  const seeded = Array.from({ length: Number(slice[1]) }, (_, i) => `OBS-2026-${String(i + 1).padStart(3, "0")}`);
  const purged = purgeConstArray("DEMO_CYCLE_CODES");
  assert.ok(purged, "purge_demo_data.ts must declare DEMO_CYCLE_CODES");
  assert.deepEqual([...purged].sort(), seeded);
  assert.doesNotMatch(PURGE, /\bLIKE\s+(\$\{|')/, "no demo recogniser may be a LIKE pattern");
});
