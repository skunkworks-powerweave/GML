// The two helpers the 2026-09 fixes share: notify() and the URL-id guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import "./_ui.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

test("isUuid accepts only canonical uuids", async () => {
  const { isUuid } = await import("../../apps/web/src/lib/ids.ts");
  assert.equal(isUuid("54d4090d-fc71-4823-95bf-ba21ab5edc89"), true);
  for (const bad of ["", "54d4090d", "54d4090d-fc71-4823-95bf-ba21ab5edc89x", "../etc", "OBS-2026-001", null, 7, undefined]) {
    assert.equal(isUuid(bad), false, JSON.stringify(bad));
  }
});

test("notify writes one row per user and entity, truncates, skips the actor, and never throws", { skip: needsDatabase() }, async () => {
  const { notify } = await import("../../packages/db/src/notify.ts");
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  const T = tag("notify");
  try {
    await c.query("BEGIN");
    const mk = async (n: string) =>
      (await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${n}.${T}@example.test`, n])).rows[0].id as string;
    const a = await mk("a");
    const b = await mk("b");
    const actor = await mk("actor");
    const db = drizzle(c);
    const n = await notify(
      db,
      [
        { userId: a, kind: "cycle.assigned", subject: "x".repeat(500), entityType: "observation_cycle", entityId: T },
        { userId: a, kind: "cycle.assigned", subject: "dup", entityType: "observation_cycle", entityId: T },
        { userId: b, kind: "cycle.assigned", subject: "for b", entityType: "observation_cycle", entityId: T },
        { userId: actor, kind: "cycle.assigned", subject: "self", entityType: "observation_cycle", entityId: T },
      ],
      { excludeUserId: actor },
    );
    assert.equal(n, 2);
    const rows = (await c.query(`SELECT user_id, length(subject) AS len FROM notifications WHERE entity_id = $1 ORDER BY len DESC`, [T])).rows;
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].len), 200, "subject is varchar(200)");
    // A failing insert (a user id that does not exist) is logged and reported as 0, not thrown.
    assert.equal(await notify(db, [{ userId: "00000000-0000-0000-0000-000000000000", kind: "cycle.assigned", subject: "ghost" }]), 0);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});
