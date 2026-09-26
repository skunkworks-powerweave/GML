// The commitments register's cap, executed through the real addCommitmentAction.
//
// ── F59 ──────────────────────────────────────────────────────────────────────
//
// The append ran when the array had fewer than 50 entries, and the action then
// checked the length AFTER the update with `>= 50` -- so adding the 50th
// commitment saved it AND redirected with ?error=commitments_full ("already
// has the maximum of 50 ... Mark some done before adding more"). The cap
// counted done items too, and nothing removes a commitment, so marking items
// done never freed a place: a weekly-meeting pairing filled up within the
// year and could never add another.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type World } from "./_mentorship.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await buildWorld("commit");
  try {
    await w.grant(w.mentor.id);
    signIn(w.mentor);
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function fill(w: World, n: number, done: boolean) {
  const items = Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    text: `item ${i}`,
    who: "mentee",
    due: null,
    done,
    doneAt: done ? new Date().toISOString() : null,
    doneBy: null,
  }));
  await w.q(`UPDATE mentor_pairings SET commitments = $2::jsonb WHERE id = $1`, [w.pairingA, JSON.stringify(items)]);
}

async function add(w: World, text: string) {
  const { addCommitmentAction } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts");
  return outcome(() => addCommitmentAction(formData({ pairingId: w.pairingA, text, who: "mentee" })));
}

const texts = async (w: World) =>
  (await w.q<{ t: string }>(`SELECT e->>'text' AS t FROM mentor_pairings, jsonb_array_elements(commitments) e WHERE id = $1`, [w.pairingA])).map((r) => r.t);

test("the 50th open commitment is saved and not reported as refused", { skip }, async () => {
  await withWorld(async (w) => {
    await fill(w, 49, false);
    const r = await add(w, "the fiftieth");
    assert.equal(r.kind, "value", `accepted silently, as any other add: ${describe(r)}`);
    assert.ok((await texts(w)).includes("the fiftieth"));
  });
});

test("a 51st open commitment is refused, and says so", { skip }, async () => {
  await withWorld(async (w) => {
    await fill(w, 50, false);
    const r = await add(w, "one too many");
    assert.deepEqual(r, { kind: "redirect", to: `/mentorship/${w.pairingA}?error=commitments_full` });
    assert.ok(!(await texts(w)).includes("one too many"));
  });
});

test("marking commitments done frees places", { skip }, async () => {
  await withWorld(async (w) => {
    await fill(w, 50, true);
    const r = await add(w, "after a year of meetings");
    assert.equal(r.kind, "value", describe(r));
    assert.ok((await texts(w)).includes("after a year of meetings"));
  });
});
