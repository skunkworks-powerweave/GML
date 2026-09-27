// An inbox row is written in its recipient's language, not the actor's.
//
// Notifications store their subject and body as text. They were always
// English, so a Hindi or Bhoti user's inbox stayed English whatever the pages
// around it said. lib/notify-localized.ts renders each row from the
// recipient's saved interface language (user_prefs.ui_language), English when
// they never chose one. Executed against the test database with the app's own
// pool and the real bundles.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { h } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture } from "./_admin-fixture.js";
import { closeAppDb } from "./_server-actions.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

void h; // _ui.js registers the @/ and server-only hooks the helper needs.
const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

test("each recipient gets the row in their own language, English when unset", { skip }, async () => {
  const { notifyLocalized } = await import("../../apps/web/src/lib/notify-localized.ts");
  const { db } = await import("@gml/db");
  await withClient(async (c) => {
    const f = fixture(c, tag("notify-i18n"));
    try {
      const hi = await f.user("teacher", "hi");
      const bo = await f.user("teacher", "bo");
      const none = await f.user("teacher", "none");
      await c.query(`INSERT INTO user_prefs (user_id, ui_language) VALUES ($1, 'hi'), ($2, 'bo')`, [hi, bo]);
      f.defer(`DELETE FROM user_prefs WHERE user_id = ANY($1)`, [[hi, bo]]);
      f.defer(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[hi, bo, none]]);

      const written = await notifyLocalized(
        db as never,
        "action",
        [hi, bo, none].map((userId) => ({
          userId,
          kind: "cycle.assigned",
          entityType: "observation_cycle",
          entityId: userId,
          text: (t, intl) => ({ subject: t("save"), body: intl }),
        })),
      );
      assert.equal(written, 3);

      const { rows } = await c.query(`SELECT user_id, subject, body FROM notifications WHERE user_id = ANY($1)`, [[hi, bo, none]]);
      const by = new Map(rows.map((r) => [r.user_id as string, r as { subject: string; body: string }]));
      const save = (l: "en" | "hi" | "bo") => (loadMessages(l).action as Record<string, string>).save;
      assert.deepEqual(by.get(hi), { user_id: hi, subject: save("hi"), body: "hi-IN" });
      assert.deepEqual(by.get(bo), { user_id: bo, subject: save("bo"), body: "bo-IN" });
      assert.deepEqual(by.get(none), { user_id: none, subject: save("en"), body: "en-IN" });
    } finally {
      await f.cleanup();
    }
  });
});
