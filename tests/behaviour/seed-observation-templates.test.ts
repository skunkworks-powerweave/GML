// The observation template seed never touches a REAL cycle.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// seed_forms_observation.ts hangs three template rows (submitted_by NULL,
// responses = { description, fields: [...] }) on "the cycle whose code is
// OBS-2026-001", and deploy.sh runs it on every deploy. README-deploy 3.1 has
// IT purge the demo data on day one, which removes OBS-2026-001..008 -- and
// nextCycleCode() mints max+1 over the codes that still exist, so the first
// REAL nomination afterwards is OBS-2026-001 again. The next deploy found it
// and attached three fake "submitted" forms to a real teacher's cycle, and
// every later deploy re-filled any kind she had not yet submitted.
//
// A business code is not an identity: the anchor has to be the DEMO cycle,
// recognised the way purge_demo_data.ts recognises demo data -- its teacher
// carries a demo phone number.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The seed's own lookup and insert run inside a transaction that is rolled
// back. Any OBS-2026-001 already in the database is renamed for the duration,
// inside the same transaction, so the test sees only the cycle it made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

// The script begins `import "dotenv/config"`. Point it at a file that does
// not exist so it can only ever see the DATABASE_URL this suite was given.
process.env.DOTENV_CONFIG_PATH = join(tmpdir(), "gml-no-such.env");

const seed = () => import("../../packages/db/src/scripts/seed_forms_observation.ts");

async function withAnchor(
  teacherPhone: string | null,
  body: (c: Client, cycleId: string) => Promise<void>,
): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  const T = tag("tplseed");
  try {
    await c.query("BEGIN");
    await c.query(`UPDATE observation_cycles SET code = code || $1 WHERE code = 'OBS-2026-001'`, [`-aside-${T}`]);
    const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
    const d = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${T}`, T.slice(-12)]);
    const z = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [d, `Z ${T}`]);
    const s = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [z, `S ${T}`, T.slice(-12)]);
    const t = await one(`INSERT INTO teachers (school_id, full_name, phone) VALUES ($1, $2, $3) RETURNING id`, [s, `T ${T}`, teacherPhone]);
    const cycleId = await one(
      `INSERT INTO observation_cycles (code, teacher_id, kind, status) VALUES ('OBS-2026-001', $1, 'baseline', 'nominated') RETURNING id`,
      [t],
    );
    await body(c, cycleId);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

const formsOn = async (c: Client, cycleId: string) =>
  (await c.query(`SELECT kind, submitted_by_user_id FROM observation_forms WHERE cycle_id = $1 ORDER BY kind`, [cycleId])).rows;

test("a real teacher's cycle that was minted OBS-2026-001 after the purge gets no template rows", { skip: needsDatabase() }, async () => {
  const { findTemplateAnchor, insertTemplates } = await seed();
  // A teacher added by the programme -- no demo phone.
  await withAnchor("+91 7000000020", async (c, cycleId) => {
    const db = drizzle(c);
    const anchor = await findTemplateAnchor(db);
    if (anchor) await insertTemplates(db, anchor.id);
    assert.deepEqual(
      await formsOn(c, cycleId),
      [],
      "the seed attached fake 'submitted' forms to a real teacher's cycle because it shares the demo cycle's code",
    );
  });
});

test("the demo cycle still receives its templates", { skip: needsDatabase() }, async () => {
  const { findTemplateAnchor, insertTemplates } = await seed();
  await withAnchor("+91 9419100001", async (c, cycleId) => {
    const db = drizzle(c);
    const anchor = await findTemplateAnchor(db);
    assert.equal(anchor?.id, cycleId, "the demo OBS-2026-001 is the anchor");
    assert.deepEqual(await insertTemplates(db, anchor!.id), { inserted: 3, skipped: 0 });
    assert.deepEqual(
      (await formsOn(c, cycleId)).map((r) => [r.kind, r.submitted_by_user_id]),
      [["observer", null], ["post", null], ["pre", null]],
    );
  });
});
