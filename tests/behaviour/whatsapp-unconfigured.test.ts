// The WhatsApp webhook while the integration is not configured yet.
//
// The programme switches WhatsApp on after go-live, so for a while the LMS runs
// with no WHATSAPP_* values at all. docker-compose.yml, deploy.sh and
// preflight.sh used to REFUSE to start without WHATSAPP_APP_SECRET, because an
// unset secret once made the webhook accept unsigned POSTs from anyone. The
// protection that matters is here, in the route, so these tests execute the
// real POST handler with the secret unset:
//
//   - nothing is processed: every request is refused, signed or not;
//   - the answer says what is wrong (503 whatsapp_not_configured, not a 401
//     that reads like a bad signature from Meta);
//   - a stray POST from the internet does not write an append-only audit row
//     each time -- with no secret there is no signature to have "failed".
//
// With the secret set, a bad signature is still a 401 and still audited.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "./_ui.js"; // the @/ alias and framework stubs, for apps/web modules
import { needsDatabase, withClient } from "./_harness.js";

const skip = needsDatabase();
const route = () => import("../../apps/web/src/app/api/webhooks/whatsapp/route.ts");

const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
const post = (headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3100/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: BODY,
  });

async function signatureAuditsSince(since: Date): Promise<number> {
  return withClient(async (c) =>
    Number(
      (
        await c.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'whatsapp.signature_failed' AND created_at >= $1`, [since])
      ).rows[0].n,
    ),
  );
}

test("unconfigured: every request is refused as 'not configured', and none is audited", { skip }, async () => {
  const saved = process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_APP_SECRET;
  try {
    const { POST } = await route();
    const since = new Date(Date.now() - 1000);
    for (const req of [post(), post({ "x-hub-signature-256": "sha256=" + "0".repeat(64) })]) {
      const res = await POST(req);
      assert.equal(res.status, 503, "not a 401: nothing about the request is wrong, the deployment is not set up");
      assert.deepEqual(await res.json(), { error: "whatsapp_not_configured" });
    }
    await new Promise((r) => setTimeout(r, 300)); // recordAudit is fire-and-forget
    assert.equal(await signatureAuditsSince(since), 0, "stray POSTs to an unconfigured webhook must not grow the append-only audit log");
  } finally {
    if (saved === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = saved;
  }
});

test("configured: a bad signature is still refused with 401 and audited; a good one is accepted", { skip }, async () => {
  const saved = process.env.WHATSAPP_APP_SECRET;
  process.env.WHATSAPP_APP_SECRET = "test-app-secret";
  try {
    const { POST } = await route();
    const since = new Date(Date.now() - 1000);
    const bad = await POST(post({ "x-hub-signature-256": "sha256=" + "0".repeat(64) }));
    assert.equal(bad.status, 401);
    const good = await POST(
      post({ "x-hub-signature-256": "sha256=" + createHmac("sha256", "test-app-secret").update(BODY).digest("hex") }),
    );
    assert.equal(good.status, 200, "an empty, correctly signed batch is accepted");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await signatureAuditsSince(since)) >= 1, "a failed signature on a configured webhook is a security event");
  } finally {
    if (saved === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = saved;
  }
});
