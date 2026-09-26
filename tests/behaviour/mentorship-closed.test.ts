// FR-12: a completed pairing is a closed record.
//
// completePairingAction set status 'complete' and ended_at, and nothing else
// looked at the status afterwards: meetings, commitments, forms and videos kept
// arriving on a finished mentorship, and a re-posted Complete overwrote
// ended_at. These drive the real actions against Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://storage.test";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "publishable-test-key";

const actions = () => import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts");

async function as<T>(who: Person, fn: () => Promise<T>) {
  signIn(who);
  return outcome(fn);
}

async function withClosedPairing(body: (w: World, endedAt: string) => Promise<void>) {
  const w = await buildWorld("pairclosed");
  try {
    for (const p of [w.admin, w.mentor, w.teacherA]) await w.grant(p.id);
    const [row] = await w.q<{ ended_at: string }>(
      `UPDATE mentor_pairings SET status = 'complete', ended_at = now() - interval '1 day' WHERE id = $1 RETURNING ended_at::text`,
      [w.pairingA],
    );
    await body(w, row!.ended_at);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

const count = async (w: World, sql: string) => (await w.q<{ n: number }>(sql, [w.pairingA]))[0]!.n;

test("FR-12: a completed pairing refuses new meetings and commitments", { skip }, async () => {
  await withClosedPairing(async (w) => {
    const { logMeetingAction, addCommitmentAction } = await actions();
    const meeting = await as(w.mentor, () =>
      logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: "2026-10-02T10:30", notes: "after the end" })),
    );
    assert.equal(meeting.kind, "redirect", describe(meeting));
    assert.match((meeting as { to: string }).to, /error=pairing_closed/);
    assert.equal(await count(w, `SELECT count(*)::int AS n FROM mentor_meetings WHERE pairing_id = $1`), 0, "no meeting recorded");

    const commitment = await as(w.mentor, () => addCommitmentAction(formData({ pairingId: w.pairingA, text: "read daily" })));
    assert.match((commitment as { to?: string }).to ?? "", /error=pairing_closed/, describe(commitment));
    assert.equal(
      await count(w, `SELECT coalesce(jsonb_array_length(commitments), 0)::int AS n FROM mentor_pairings WHERE id = $1`),
      0,
      "no commitment recorded",
    );
  });
});

test("FR-12: completing a completed pairing again changes nothing", { skip }, async () => {
  await withClosedPairing(async (w, endedAt) => {
    const { completePairingAction } = await actions();
    const r = await as(w.admin, () => completePairingAction(formData({ pairingId: w.pairingA })));
    assert.match((r as { to?: string }).to ?? "", /error=pairing_closed/, describe(r));
    const [row] = await w.q<{ ended_at: string }>(`SELECT ended_at::text FROM mentor_pairings WHERE id = $1`, [w.pairingA]);
    assert.equal(row!.ended_at, endedAt, "ended_at was overwritten");
  });
});

test("FR-12: a completed pairing refuses a quarterly video before anything is reserved", { skip }, async () => {
  await withClosedPairing(async (w) => {
    const { beginUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    const r = await as(w.teacherA, () =>
      beginUploadAction({ filename: "q1.mp4", sizeBytes: 2048, contentType: "video/mp4", contextType: "mentee_quarterly", contextId: w.pairingA, quarter: 1 }),
    );
    const v = (r as { value?: { ok: boolean; error?: string } }).value;
    assert.equal(v?.ok, false, describe(r));
    assert.match(v?.error ?? "", /complete/i);
    assert.equal(
      await count(w, `SELECT count(*)::int AS n FROM video_submissions WHERE context_type = 'mentee_quarterly' AND context_id = $1`),
      0,
      "nothing reserved",
    );
  });
});

test("FR-12: the completed pairing's page offers no meeting log, no new commitment, and no live tick boxes", { skip }, async () => {
  await withClosedPairing(async (w) => {
    await w.q(`UPDATE mentor_pairings SET commitments = $2::jsonb WHERE id = $1`, [
      w.pairingA,
      JSON.stringify([{ id: "11111111-1111-4111-8111-111111111111", text: "read daily", who: "mentee", done: false }]),
    ]);
    const { render, decodeEntities } = await import("./_ui.js");
    const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
    signIn(w.mentor);
    const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve({}) }));
    assert.equal(r.kind, "value", describe(r));
    const html = decodeEntities(await render((r as { value: unknown }).value));
    assert.doesNotMatch(html, /name="text"/, "the add-commitment form is still offered");
    assert.doesNotMatch(html, /aria-label="Log a new meeting"/, "the meeting log is still offered");
    assert.match(html, /<button[^>]*aria-label="Mark commitment: read daily"[^>]*disabled=""/, "the tick box is still live");
  });
});
