// Concurrent password rotations each get their own version, and the password
// shown for the newest one is the one that works.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The rotate route computed nextVersion = max(version) + 1 OUTSIDE its
// transaction, and section_gates had no unique (slug, version). Two
// rotations of the same slug at once (two super admins, or two tabs) both
// inserted version N; getCurrentGate() orders by version DESC LIMIT 1, which
// is arbitrary between equal versions, so one of the two "shown once"
// passwords was dead -- and if that admin distributed it, the section was
// locked for everyone until someone rotated again.
//
// Executed: the real route handler, four times concurrently, as a super_admin,
// on the unused `tkt` slug, against Postgres; then the real getCurrentGate().

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const bcrypt = createRequire(new URL("../../apps/web/package.json", import.meta.url))("bcryptjs") as {
  compare: (a: string, b: string) => Promise<boolean>;
};

test("four simultaneous rotations produce four versions, and the newest password works", { skip, timeout: 120_000 }, async () => {
  const { POST } = await import("../../apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts");
  const { getCurrentGate } = await import("../../apps/web/src/lib/gates.ts");
  await withClient(async (c) => {
    const t = tag("rotate");
    const f = fixture(c, t);
    try {
      const admin = await f.user("super_admin", "sadmin");
      f.defer(`DELETE FROM section_gates WHERE rotated_by_user_id = $1`, [admin]);
      actAs(admin, "super_admin");
      const call = () =>
        POST(new Request("http://x/api/admin/gates/tkt/rotate", { method: "POST" }), {
          params: Promise.resolve({ slug: "tkt" }),
        }).then((r) => r.json() as Promise<{ ok?: boolean; plaintext?: string; version?: number }>);
      const results = await Promise.all([call(), call(), call(), call()]);
      const versions = results.map((r) => r.version);
      assert.equal(new Set(versions).size, 4, `duplicate versions: ${versions.join(",")}`);

      const newest = results.reduce((a, b) => ((a.version ?? 0) > (b.version ?? 0) ? a : b));
      const current = await getCurrentGate("tkt");
      assert.equal(current?.version, newest.version);
      assert.equal(await bcrypt.compare(newest.plaintext!, current!.passwordHash), true, "the newest shown password must open the gate");
    } finally {
      await f.cleanup();
    }
  });
});

test("the database refuses two rows with one slug and version", { skip }, async () => {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`INSERT INTO section_gates (slug, password_hash, version) VALUES ('ttt', 'x', 99001)`);
      await assert.rejects(
        c.query(`INSERT INTO section_gates (slug, password_hash, version) VALUES ('ttt', 'y', 99001)`),
        /duplicate key|unique/i,
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

// ── MIGRATION 0034 ON A DEPLOYMENT THAT ALREADY HAS A DUPLICATE ──────────────
//
// The index cannot be built over existing duplicates, so 0034 renumbers them
// first. Its first version moved every row after the first of a duplicated
// (slug, version) to max(version) + 1 -- ABOVE any later, legitimate
// rotation. With v3 twice on 1 September and a real rotation to v4 on 10
// September, the stale 1 September duplicate became v5, the current gate,
// and the password the 10 September admin had distributed stopped working.
//
// Executed: the migration's own renumbering block, on a copy of section_gates
// in a scratch schema of a rolled-back transaction (the real table has the
// index, so it cannot hold a duplicate), then getCurrentGate()'s query --
// lib/gates.ts: that slug's highest version -- on the same transaction.
test("migration 0034 keeps the latest rotation current when a duplicate sits below it", { skip }, async () => {
  const { readFileSync } = await import("node:fs");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { desc, eq } = await import("drizzle-orm");
  const { sectionGates } = await import("../../packages/db/src/schema/gates.ts");
  const migration = readFileSync(new URL("../../packages/db/src/migrations/0034_gate_version_unique.sql", import.meta.url), "utf8");
  const [renumber, index] = migration.split("--> statement-breakpoint");
  assert.match(renumber!, /DO \$\$/);
  assert.match(index!, /CREATE UNIQUE INDEX/);
  await withClient(async (c) => {
    const schema = `gate_mig_${tag("m").replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
    await c.query("BEGIN");
    try {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE ${schema}.section_gates (LIKE public.section_gates INCLUDING DEFAULTS)`);
      await c.query(`SET LOCAL search_path = ${schema}, public`);
      const put = (slug: string, version: number, hash: string, at: string) =>
        c.query(`INSERT INTO section_gates (slug, version, password_hash, created_at, rotated_at) VALUES ($1, $2, $3, $4, $4)`, [
          slug,
          version,
          hash,
          at,
        ]);
      await put("tkt", 1, "tkt-aug-01", "2026-08-01T04:00:00Z");
      await put("tkt", 2, "tkt-aug-15", "2026-08-15T04:00:00Z");
      await put("tkt", 3, "tkt-sep-01-a", "2026-09-01T04:00:00Z");
      await put("tkt", 3, "tkt-sep-01-b", "2026-09-01T04:00:01Z");
      await put("tkt", 4, "tkt-sep-10", "2026-09-10T04:00:00Z");
      // A slug with no duplicate keeps its numbers, gaps and all.
      await put("ttt", 1, "ttt-v1", "2026-08-01T04:00:00Z");
      await put("ttt", 3, "ttt-v3", "2026-08-20T04:00:00Z");

      await c.query(renumber!);
      await c.query(index!); // the index now builds

      const current = async (slug: "tkt" | "ttt") =>
        (await drizzle(c).select().from(sectionGates).where(eq(sectionGates.slug, slug)).orderBy(desc(sectionGates.version)).limit(1))[0];
      assert.equal((await current("tkt"))?.passwordHash, "tkt-sep-10", "the 10 September rotation must stay the current password");
      const { rows } = await c.query(`SELECT password_hash, version FROM section_gates WHERE slug = 'tkt' ORDER BY version`);
      assert.deepEqual(
        rows.map((r) => r.password_hash),
        ["tkt-aug-01", "tkt-aug-15", "tkt-sep-01-a", "tkt-sep-01-b", "tkt-sep-10"],
        "versions follow creation order",
      );
      const { rows: ttt } = await c.query(`SELECT version FROM section_gates WHERE slug = 'ttt' ORDER BY version`);
      assert.deepEqual(ttt.map((r) => r.version), [1, 3]);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
