// One recipient who no longer exists does not cost everyone else their message.
//
// notify() wrote every row in one INSERT. When one recipient's users row was
// gone by the time it ran (deleted between choosing the recipients and
// writing), the foreign key refused the whole statement and nobody was told --
// seen as an approvals test that failed one run in four while other tests
// deleted their fixture admins. Now a refused batch is retried row by row and
// only the missing recipient is skipped.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture } from "./_admin-fixture.js";
import { closeAppDb } from "./_server-actions.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

test("a batch with a recipient who does not exist still reaches the others", { skip }, async () => {
  const { notify } = await import("../../packages/db/src/notify.ts");
  const { db } = await import("../../packages/db/src/client.ts");
  await withClient(async (c) => {
    const f = fixture(c, tag("notify-missing"));
    try {
      const a = await f.user("programme_admin", "a");
      const b = await f.user("programme_admin", "b");
      f.defer(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[a, b]]);
      const gone = randomUUID();
      const written = await notify(db as never, [a, gone, b].map((userId) => ({ userId, kind: "approval", subject: "Waiting for you" })));
      assert.equal(written, 2, "the two existing recipients are written");
      const { rows } = await c.query(`SELECT user_id FROM notifications WHERE user_id = ANY($1) ORDER BY user_id`, [[a, b]]);
      assert.deepEqual(rows.map((r) => r.user_id).sort(), [a, b].sort());
    } finally {
      await f.cleanup();
    }
  });
});
