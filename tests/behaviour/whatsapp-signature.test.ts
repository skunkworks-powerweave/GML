// Unsigned POSTs to the WhatsApp webhook, executed.
//
// ── THE DEFECT (F97, the webhook's share of it) ──────────────────────────────
//
// The webhook is public by necessity (Meta has to reach it), and every POST
// that failed the signature check wrote one 'whatsapp.signature_failed' row
// into audit_log -- the table that is append-only by trigger and can never be
// cleaned. There was no rate limit in the app or in Caddy, so a loop of
// `curl -X POST .../api/webhooks/whatsapp -d '{}'` grew the database without
// bound and buried the events /admin/audit exists to show. The rows carried
// no metadata either, so there was nothing forensic in them to justify one per
// request.
//
// A failed signature on a configured webhook is still a security event and
// is still recorded -- a bounded number of times per source, with the masked
// source and whether a signature was even offered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { request, resetRequest } from "./_ui.js";
import { route, SECRET, waitForStableCount, withEnv } from "./_whatsapp.js";

const skip = needsDatabase();

test("F97: a flood of unsigned POSTs is refused every time but audited a bounded number of times", { skip }, async () => {
  await withEnv({ WHATSAPP_APP_SECRET: SECRET }, async () => {
    const { POST } = await route();
    // One source, unique to this run so earlier runs' counters do not interfere.
    const a = 1 + Math.floor(Math.random() * 250);
    const b = 1 + Math.floor(Math.random() * 250);
    const ip = `10.${a}.${b}.7`;
    const masked = `10.${a}.${b}.x`;
    const since = new Date(Date.now() - 1000);
    // recordAudit reads the user agent through next/headers, which the harness
    // serves from `request`; a unique one lets this count exactly our rows.
    const ua = tag("wa-flood");
    request.headers = { "user-agent": ua, "x-real-ip": ip };

    const flood = Array.from({ length: 25 }, (_, i) =>
      POST(
        new Request("http://127.0.0.1:3100/api/webhooks/whatsapp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": ip,
            ...(i % 2 ? { "x-hub-signature-256": "sha256=" + "0".repeat(64) } : {}),
          },
          body: "{}",
        }),
      ),
    );
    const statuses = (await Promise.all(flood)).map((r) => r.status);
    assert.deepEqual([...new Set(statuses)], [401], "every unsigned or wrongly signed POST is still refused");

    // The rows are written fire-and-forget. The upper bound is checked on a
    // count that has stopped growing, not on whatever had landed after a sleep.
    const rows = await withClient(async (c) => {
      const read = async () =>
        (
          await c.query(
            `SELECT metadata FROM audit_log
              WHERE action = 'whatsapp.signature_failed' AND created_at >= $1 AND user_agent = $2`,
            [since, ua],
          )
        ).rows;
      await waitForStableCount(async () => (await read()).length);
      return read();
    });
    resetRequest();
    assert.ok(rows.length >= 1, "a failed signature on a configured webhook is still a security event");
    assert.ok(rows.length <= 5, `25 POSTs from one source wrote ${rows.length} permanent audit rows`);
    const md = rows[0]!.metadata as Record<string, unknown>;
    assert.equal(md.ipMasked, masked, "the row names the (masked) source it came from");
    assert.equal(typeof md.signatureProvided, "boolean", "the row says whether a signature was even offered");
  });
});
