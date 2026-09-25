// The operator runbook for switching WhatsApp on, checked against the code it
// describes.
//
// ── THE DEFECT (F142) ────────────────────────────────────────────────────────
//
// README-IT and README-deploy listed the WHATSAPP_* variable names and never
// said how to connect Meta to a deployment: not the callback URL, not that the
// app must be subscribed to the 'messages' webhook field, not where the app
// secret lives, not that the dashboard's temporary token expires in 24 hours
// (after which, with the old code, every video was silently dropped), and not
// how to confirm it end to end. An IT team would have had to read route.ts.
//
// The runbook's handshake example is EXECUTED against the real GET handler,
// so a runbook that drifts from the route fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDatabase } from "./_harness.js";
import { route, withEnv } from "./_whatsapp.js";

const README = readFileSync(new URL("../../README-IT.md", import.meta.url), "utf8");
const ENV_EXAMPLE = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

function section(): string {
  const start = README.indexOf("## WhatsApp Business setup");
  assert.ok(start >= 0, "README-IT.md has no 'WhatsApp Business setup' section");
  const end = README.indexOf("\n## ", start + 1);
  return README.slice(start, end < 0 ? undefined : end);
}

test("F142: the runbook covers what Meta needs, in the order an operator does it", () => {
  const s = section();
  for (const [what, re] of [
    ["the callback URL", /https:\/\/<DOMAIN>\/api\/webhooks\/whatsapp/],
    ["subscribing to the messages field", /subscribe[^.]*\*\*messages\*\*/i],
    ["where the app secret is", /App settings > Basic/],
    ["that the dashboard token expires", /24 hours/],
    ["a permanent system-user token", /system user/i],
    ["the permission the token needs", /whatsapp_business_messaging/],
    ["the phone number id, not the number", /Phone number ID/],
    ["an end-to-end check", /\/admin\/whatsapp-log/],
  ] as const) {
    assert.match(s, re, `the runbook must say ${what}`);
  }
  for (const v of ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) {
    assert.ok(s.includes(v), `the runbook must say where ${v} comes from`);
  }
  // The callback path is the route that exists.
  const path = s.match(/https:\/\/<DOMAIN>(\/api\/webhooks\/whatsapp)/)![1]!;
  assert.ok(
    existsSync(fileURLToPath(new URL(`../../apps/web/src/app${path}/route.ts`, import.meta.url))),
    `${path} must be a real route`,
  );
  // .env.example is where the token is pasted; it must warn about the same trap.
  const tokenNote = ENV_EXAMPLE.slice(0, ENV_EXAMPLE.indexOf("WHATSAPP_ACCESS_TOKEN="));
  assert.match(tokenNote.slice(-800), /permanent|system.user/i, ".env.example must say the access token has to be permanent");
});

test("F142: the runbook's handshake command works against the real webhook", { skip: needsDatabase() }, async () => {
  const s = section();
  const curl = s.match(/curl "(https:\/\/<DOMAIN>\/api\/webhooks\/whatsapp\?[^"]+)"/);
  assert.ok(curl, "the runbook must give the handshake as a curl command");
  const expected = s.match(/must print `([^`]+)`/)?.[1];
  assert.ok(expected, "the runbook must say what the handshake prints");
  const url = curl[1]!.replace("<DOMAIN>", "lms.example.test").replace("<WHATSAPP_VERIFY_TOKEN>", "runbook-verify-token");
  await withEnv({ WHATSAPP_VERIFY_TOKEN: "runbook-verify-token" }, async () => {
    const { GET } = await route();
    const res = await GET(new Request(url));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), expected);
  });
});
