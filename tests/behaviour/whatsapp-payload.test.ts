// Correctly signed payloads of a shape the webhook does not expect, executed.
//
// ── THE DEFECT (F101) ────────────────────────────────────────────────────────
//
// The body was cast to a TypeScript type (`JSON.parse(raw) as WhatsAppPayload`)
// and walked with for...of. A body of `null`, `entry` as a number, a null
// element or `messages` as an object threw a TypeError and answered 500 --
// and Meta treats a 5xx as retryable and keeps redelivering a payload the code
// will never understand. Only Meta can sign, so the realistic cause is Meta's
// schema drifting; the answer to that is a recorded "unrecognised" and a 200,
// not an endless retry loop. A malformed message must not take the valid
// messages in the same batch down with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, withClient } from "./_harness.js";
import { envelope, route, SECRET, signed, videoMessage, waitFor, withEnv, withWorld } from "./_whatsapp.js";

const skip = needsDatabase();

test("F101: a signed payload of an unexpected shape is a recorded 200, not a 500 Meta retries forever", { skip }, async () => {
  await withEnv({ WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined }, async () => {
    const { POST } = await route();
    const since = new Date(Date.now() - 1000);
    const bodies = [
      "null",
      '"a string"',
      '{"entry":5}',
      '{"entry":[null]}',
      '{"entry":[{"changes":[null]}]}',
      '{"entry":[{"changes":[{"value":{"messages":{"a":1}}}]}]}',
      '{"entry":[{"changes":[{"value":{"messages":[{"type":"video"}]}}]}]}',
    ];
    for (const b of bodies) {
      const res = await POST(signed(b));
      assert.equal(res.status, 200, `${b} answered ${res.status}`);
    }
    const n = await waitFor(
      () =>
        withClient(async (c) =>
          Number(
            (await c.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'whatsapp.payload.unrecognised' AND created_at >= $1`, [since]))
              .rows[0].n,
          ),
        ),
      (count) => count >= bodies.length,
    );
    assert.ok(n >= bodies.length, `each unrecognised payload is recorded (${n} rows for ${bodies.length} bodies)`);
  });
});

test("F101: one malformed message does not lose the valid video beside it", { skip }, async () => {
  await withEnv({ WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined }, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const good = w.wamid();
      const res = await POST(
        signed(
          envelope([
            null,
            { type: "video", id: 42, video: "nope" },
            videoMessage({ id: good, from: w.teacher.phone, caption: w.cycleCode }),
          ]),
        ),
      );
      assert.equal(res.status, 200);
      assert.ok(await w.submission(good), "the well-formed video in the batch is still ingested");
    }),
  );
});
