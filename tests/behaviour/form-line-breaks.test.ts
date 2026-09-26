// A text answer the browser allowed is not refused by the server as too long.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Every free-text textarea carries maxLength={MAX_TEXT_LENGTH} (5,000), and the
// browser counts maxlength on the LF value: one character per line break. A
// form posts each line break as CRLF, two characters, and Next's decoders keep
// the CR. parseStageResponses only trimmed and validateResponses measured
// raw.length, so a reflection of 5,000 characters with line breaks, which the
// browser let through, came back "blank or longer than 5,000 characters" and
// the cycle did not move on. The forms runner goes through the same
// validateResponses, so its answers were refused the same way.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The server's own parsing and validation, fed values as the wire delivers
// them (CRLF), and the real submitPostFormAction end to end.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { parseStageResponses } from "../../apps/web/src/lib/observation/forms.ts";
import { MAX_TEXT_LENGTH, validateResponses, type FormField } from "../../apps/web/src/lib/forms/validate.ts";

const skip = needsDatabase();
after(closeAppDb);

// `length` characters as the browser counts them (LF line breaks), with a line
// break every 50 (never last, which trimming would drop): what a textarea at
// its maxlength holds.
function answer(length: number): string {
  let s = "";
  while (s.length < length) s += (s.length + 1) % 50 === 0 && s.length < length - 1 ? "\n" : "a";
  return s;
}
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

test("a stage answer at the cap, posted with CRLF line breaks, is accepted and stored with LF", () => {
  const typed = answer(MAX_TEXT_LENGTH);
  assert.equal(typed.length, MAX_TEXT_LENGTH);
  assert.ok(crlf(typed).length > MAX_TEXT_LENGTH, "the posted value is longer than what the browser counted");

  const fd = new FormData();
  fd.set("whatWorked", crlf(typed));
  const parsed = parseStageResponses("post", fd);
  assert.equal(parsed.ok, true, `the browser allowed it, the server refused it: ${JSON.stringify(parsed.ok || parsed)}`);
  assert.ok(parsed.ok && parsed.responses.whatWorked === typed, "what is stored is what was typed, LF only");

  // One character over what the browser allows is still refused.
  fd.set("whatWorked", crlf(answer(MAX_TEXT_LENGTH + 1)));
  assert.deepEqual(parseStageResponses("post", fd), { ok: false, field: "whatWorked" });

  // A lone CR (old Mac line breaks) is a line break too.
  fd.set("whatWorked", "one\rtwo\r\nthree");
  assert.deepEqual(parseStageResponses("post", fd), { ok: true, responses: { whatWorked: "one\ntwo\nthree" } });
});

test("the forms runner's validation counts a line break as the browser does", () => {
  const field = { name: "reflection", kind: "textarea", label: "Reflection", required: true } as FormField;
  assert.deepEqual(validateResponses([field], { reflection: crlf(answer(MAX_TEXT_LENGTH)) }), []);
  assert.equal(validateResponses([field], { reflection: crlf(answer(MAX_TEXT_LENGTH + 1)) }).length, 1);

  // A field's own length bounds are measured the same way.
  const bounded = { ...field, min: 5, max: 7 } as FormField;
  assert.deepEqual(validateResponses([bounded], { reflection: "ab\r\ncd\r\ne" }), [], "7 characters as typed");
  assert.equal(validateResponses([bounded], { reflection: "ab\r\ncd\r\nef" }).length, 1, "8 characters as typed");
});

test("the post-form reflection the browser allowed moves the cycle on", { skip }, async () => {
  const w = await observationWorld("obscrlf");
  try {
    const { submitPostFormAction } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    const typed = answer(MAX_TEXT_LENGTH);
    signIn(w.teacher);
    const out = await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: crlf(typed) })));
    assert.deepEqual(out, { kind: "redirect", location: `/observation/${cyc.id}` }, JSON.stringify(out));
    const row = (await w.c.query(`SELECT status FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0];
    assert.equal(row.status, "post_submitted");
    const stored = (await w.c.query(`SELECT responses FROM observation_forms WHERE cycle_id = $1 AND kind = 'post'`, [cyc.id])).rows[0];
    assert.ok(stored.responses.whatWorked === typed, "stored as typed, LF only");
  } finally {
    await w.cleanup();
  }
});
