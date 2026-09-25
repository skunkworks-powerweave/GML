// The helpdesk contact settings, as the runbooks describe them, as assertEnv()
// reads them.
//
// ── DOCUMENTED IN A FORM THE VALIDATOR REJECTS ───────────────────────────────
//
// README-IT described GML_HELPDESK_PHONE as "wa.me-ready E.164 without the
// plus". assertEnv() (apps/web/src/lib/env.ts) requires /^\+\d{8,15}$/, so a
// value entered exactly as documented was rejected: it became null, a SEVERE
// line went to the app log, and the Help panel's "Talk to a person" WhatsApp
// card disappeared for every user. The fix is the documentation: the '+' is
// what makes the country code explicit, and a validator that guessed one for a
// bare number would turn a ten-digit local number into a wrong international
// one. This test feeds the documented examples to the real validator.
//
// ── A SEVERE LINE ON EVERY PAGE VIEW ─────────────────────────────────────────
//
// assertEnv() runs in the authenticated layout -- on every render, twice on
// /videos -- and logged its SEVERE block each time, although its own comment
// says it is there so "the operator sees the misconfiguration in the boot
// logs". One typo flooded the rotated app log and pushed out every useful line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const PHONES = ["GML_HELPDESK_PHONE", "GML_WHATSAPP_NUMBER"] as const;

/** The README-IT table row for a variable. */
const readmeRow = (name: string) => read("README-IT.md").split(/\r?\n/).find((l) => l.startsWith(`| \`${name}\``)) ?? "";

test("README-IT describes the GML_* phone numbers in the form assertEnv() accepts", async () => {
  const { assertEnv } = await import("../../apps/web/src/lib/env.ts");
  for (const name of PHONES) {
    const row = readmeRow(name);
    assert.ok(row, `README-IT has no row for ${name}`);
    assert.doesNotMatch(row, /without the plus/i, `README-IT tells IT to drop the '+' from ${name}, which assertEnv() rejects`);
    const example = row.match(/`(\+?\d{8,16})`/)?.[1];
    assert.ok(example, `README-IT's ${name} row must show an example value:\n${row}`);
    process.env[name] = example;
    const summary = assertEnv();
    const check = name === "GML_WHATSAPP_NUMBER" ? summary.whatsappNumber : summary.helpdeskPhone;
    assert.equal(check.present, true, `the documented example ${example} for ${name} is rejected: ${check.reason}`);
    delete process.env[name];
  }
});

test(".env.example shows the GML_* phone format, and its example passes", async () => {
  const { assertEnv } = await import("../../apps/web/src/lib/env.ts");
  const example = read(".env.example");
  for (const name of PHONES) {
    const at = example.indexOf(`${name}=`);
    assert.ok(at >= 0, `.env.example has no ${name}`);
    // The comment block right above the helpdesk settings.
    const before = example.slice(Math.max(0, example.lastIndexOf("# ──", at)), at);
    const shown = before.match(/(\+\d{8,15})\b/)?.[1];
    assert.ok(shown, `.env.example must show the format of ${name} (E.164 with the leading +) above it`);
    process.env[name] = shown;
    assert.equal(
      (name === "GML_WHATSAPP_NUMBER" ? assertEnv().whatsappNumber : assertEnv().helpdeskPhone).present,
      true,
    );
    delete process.env[name];
  }
});

test("an invalid GML_* value is reported once per process, not on every page render", async () => {
  // assertEnv() runs in the authenticated layout, so each call here is a page
  // view. The invalid value must still be refused every time; only the log
  // line is once.
  const { assertEnv } = await import("../../apps/web/src/lib/env.ts");
  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  env.GML_HELPDESK_PHONE = "12345";
  const lines: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    for (let view = 0; view < 5; view++) {
      assert.equal(assertEnv().helpdeskPhone.present, false, "the invalid value is refused on every call");
    }
  } finally {
    console.error = error;
    env.NODE_ENV = nodeEnv;
    delete env.GML_HELPDESK_PHONE;
  }
  const severe = lines.filter((l) => l.includes("[SEVERE][spec169]"));
  assert.equal(
    severe.length,
    1,
    `five page views logged ${severe.length} SEVERE blocks for one unchanged misconfiguration:\n${severe.join("\n")}`,
  );
  assert.match(severe[0]!, /GML_HELPDESK_PHONE/, "the one line must still name the variable");
});
