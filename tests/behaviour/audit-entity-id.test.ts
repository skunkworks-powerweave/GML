// A create is audited with the id of the row it created.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// withAudit wrote its metadata as given, and a create cannot know its id until
// the INSERT returns. So every `admin.row.create` -- the generic admin grid and
// the purpose-built /observation/new alike -- landed with entity_id NULL. On
// the local stack after a morning of use: 14 creates, 0 with an entity id. The
// append-only forensic log could say that SOMEONE created SOMETHING in a table,
// and could not be joined to the row, so "who created OBS-2026-009?" had no
// answer short of guessing by timestamp.
//
// Executed through the real withAudit and recordAudit into Postgres. audit_log
// is append-only by design (SM-1), so the rows these tests write are tagged and
// left behind in the test database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "./_ui.js"; // the @/ alias, the server-only, next/headers and @/auth stubs
import { needsDatabase, withClient, tag } from "./_harness.js";

const skip = needsDatabase();

/** recordAudit is fire-and-forget, so wait for its row to land. */
async function auditRow(entityType: string): Promise<{ action: string; entity_id: string | null } | undefined> {
  for (let i = 0; i < 40; i++) {
    const row = await withClient(async (c) =>
      (await c.query(`SELECT action, entity_id FROM audit_log WHERE entity_type = $1 ORDER BY created_at DESC LIMIT 1`, [entityType])).rows[0],
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

test("a create is audited with the id the INSERT returned", { skip }, async () => {
  const { withAudit } = await import("../../apps/web/src/lib/audit.ts");
  const entityType = tag("audit-create");
  const createdId = randomUUID();
  const create = withAudit(async () => createdId, {
    action: "admin.row.create",
    entityType,
    entityIdFrom: (id: string) => id,
  });
  assert.equal(await create(), createdId, "the wrapped action's result is returned unchanged");
  const row = await auditRow(entityType);
  assert.ok(row, "the create must be audited");
  assert.equal(row.entity_id, createdId, "without the id the audit row cannot be joined to what was created");
});

test("an explicit entityId still wins, and a failure is audited as .failed without inventing an id", { skip }, async () => {
  const { withAudit } = await import("../../apps/web/src/lib/audit.ts");
  const updated = tag("audit-update");
  const known = randomUUID();
  await withAudit(async () => randomUUID(), { action: "admin.row.update", entityType: updated, entityId: known, entityIdFrom: (id: string) => id })();
  assert.equal((await auditRow(updated))?.entity_id, known);

  const failing = tag("audit-fail");
  await assert.rejects(
    withAudit(async (): Promise<string> => { throw new Error("boom"); }, { action: "admin.row.create", entityType: failing, entityIdFrom: (id: string) => id })(),
  );
  const row = await auditRow(failing);
  assert.equal(row?.action, "admin.row.create.failed");
  assert.equal(row?.entity_id, null);
});
