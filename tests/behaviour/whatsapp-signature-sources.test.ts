// Unsigned POSTs from many sources at once, executed.
//
// ── THE GAP (F97, second half) ───────────────────────────────────────────────
//
// Signature failures were audited at most 5 times per masked source (/24 or
// /64) per minute, and that was the only bound. Anyone who can rotate
// prefixes -- a free /48 IPv6 tunnel is 65,536 /64s, a botnet is more -- still
// wrote 5 rows per prefix per minute into the append-only log. There is now a
// ceiling on the total as well, whatever the number of sources.
//
// Its own file, because the ceiling is shared by everything in the process:
// run after whatsapp-signature.test.ts in the same process, this would spend
// the budget that test expects to find.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { request, resetRequest } from "./_ui.js";
import { route, SECRET, waitForStableCount, withEnv } from "./_whatsapp.js";

const skip = needsDatabase();

test("F97: signature failures from many sources are audited a bounded number of times in total", { skip }, async () => {
  await withEnv({ WHATSAPP_APP_SECRET: SECRET }, async () => {
    const { POST } = await route();
    const since = new Date(Date.now() - 1000);
    const ua = tag("wa-sources");
    request.headers = { "user-agent": ua };

    // 120 different /24s, one wrongly signed POST each: every one is within
    // its own source's budget.
    const a = 1 + Math.floor(Math.random() * 250);
    const statuses = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        POST(
          new Request("http://127.0.0.1:3100/api/webhooks/whatsapp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-real-ip": `10.${a}.${i}.9`,
              "x-hub-signature-256": "sha256=" + "0".repeat(64),
            },
            body: "{}",
          }),
        ).then((r) => r.status),
      ),
    );
    assert.deepEqual([...new Set(statuses)], [401], "every one is still refused");

    const n = await withClient((c) =>
      waitForStableCount(async () =>
        Number(
          (
            await c.query(
              `SELECT count(*) AS n FROM audit_log
                WHERE action = 'whatsapp.signature_failed' AND created_at >= $1 AND user_agent = $2`,
              [since, ua],
            )
          ).rows[0].n,
        ),
      ),
    );
    resetRequest();
    assert.ok(n >= 1, "a failed signature is still a security event");
    assert.ok(n <= 30, `120 sources wrote ${n} permanent audit rows in one minute`);
  });
});
