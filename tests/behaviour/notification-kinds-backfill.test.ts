// The notifications_enabled backfills turn on the kinds the application
// writes, and leave an administrator's choices alone -- executed against the
// real settings row, inside a transaction that is rolled back.
//
// ── W3-03 ────────────────────────────────────────────────────────────────────
//
// meeting.cancelled and cycle.complete were written (cancelMeetingAction, the
// cycle sign-off) and hidden: /inbox and the bell show only the kinds in
// system_settings.notifications_enabled, and neither was in its default. The
// schema default is corrected; _post/010 corrects the row a deployment already
// has, which a column default never touches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { needsDatabase, withClient } from "./_harness.js";

const skip = needsDatabase();
const POST = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "packages/db/src/migrations/_post");
const sql = (file: string) => readFileSync(resolve(POST, file), "utf8");

/** Run `file` over a settings row holding `start`, and return what it leaves. Rolled back. */
async function after(c: Client, file: string, start: unknown): Promise<unknown> {
  await c.query("BEGIN");
  try {
    await c.query(`UPDATE system_settings SET notifications_enabled = $1::jsonb`, [JSON.stringify(start)]);
    await c.query(sql(file));
    await c.query(sql(file)); // the _post lane replays on every deploy
    const { rows } = await c.query(`SELECT notifications_enabled AS v FROM system_settings`);
    return rows[0]!.v;
  } finally {
    await c.query("ROLLBACK");
  }
}

const sorted = (v: unknown) => [...(v as string[])].sort();

test("_post/010 turns on meeting.cancelled and cycle.complete beside their companions, once", { skip }, async () => {
  await withClient(async (c) => {
    const file = "010_notification_kinds_cancel_complete.sql";
    assert.deepEqual(
      sorted(await after(c, file, ["cycle.assigned", "video.transcoded", "meeting.scheduled", "helpdesk.ticket"])),
      ["cycle.assigned", "cycle.complete", "helpdesk.ticket", "meeting.cancelled", "meeting.scheduled", "video.transcoded"],
      "the shipped default gains both kinds, and a second run adds no duplicate",
    );
    assert.deepEqual(
      sorted(await after(c, file, ["helpdesk.ticket", "cycle.assigned"])),
      ["cycle.assigned", "cycle.complete", "helpdesk.ticket"],
      "an administrator who switched meeting notices off keeps them off",
    );
    assert.deepEqual(
      sorted(await after(c, file, ["meeting.scheduled"])),
      ["meeting.cancelled", "meeting.scheduled"],
      "an administrator who switched cycle notices off keeps them off",
    );
    assert.deepEqual(await after(c, file, []), [], "every kind switched off stays off");
  });
});

// W3-33: pairing.final_submitted is new with its producer (submitFormAction,
// on a pairing's final form), so its absence was nobody's choice.
test("_post/011 turns on pairing.final_submitted, once, unless every kind is off", { skip }, async () => {
  await withClient(async (c) => {
    const file = "011_final_form_notification_backfill.sql";
    assert.deepEqual(
      sorted(await after(c, file, ["helpdesk.ticket", "meeting.scheduled"])),
      ["helpdesk.ticket", "meeting.scheduled", "pairing.final_submitted"],
      "added, and a second run adds no duplicate",
    );
    assert.deepEqual(await after(c, file, []), [], "every kind switched off stays off");
  });
});

test("the column default names every kind the application writes", { skip }, async () => {
  await withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT column_default AS d FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'system_settings' AND column_name = 'notifications_enabled'`,
    );
    const d = String(rows[0]!.d);
    for (const kind of ["helpdesk.ticket", "cycle.assigned", "cycle.complete", "meeting.scheduled", "meeting.cancelled", "pairing.final_submitted"]) {
      assert.ok(d.includes(`"${kind}"`), `${kind} is on by default: ${d}`);
    }
  });
});
