// A mentee's quarterly video over WhatsApp -- executed through the real
// caption parser, webhook and worker, against Postgres.
//
// ── THE DEFECT (F50, the WhatsApp half) ──────────────────────────────────────
//
// WhatsApp is the programme's primary video path, and it had no way to carry a
// mentee's Q1 or Q4 video to her pairing: parseCaption knew only OBS-, TB- and
// MM-, and the webhook's context type left 'mentee_quarterly' out entirely. A
// quarterly video sent on WhatsApp could only arrive as 'generic' -- visible to
// the sender and administrators, never to her mentor.
//
// Now "Q1-<pairing>" and "Q4-<pairing>" (the /uploads page for that video shows
// the code, and pre-fills it into WhatsApp) name the pairing and the quarter,
// under the same rules as the direct upload: the sender must be on the pairing,
// and the Q4 video opens with the pairing's last quarter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";
import {
  acceptAndClaim,
  envelope,
  fakeGraph,
  fakeStorage,
  route,
  SECRET,
  signed,
  videoMessage,
  waitFor,
  withEnv,
  withWorld,
  type World,
} from "./_whatsapp.js";

const skip = needsDatabase();
const CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };

test("F50: parseCaption reads Q1-/Q4- with a pairing id as a quarterly video", async () => {
  const { parseCaption } = await import("../../packages/shared/src/whatsapp/caption.ts");
  const id = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  assert.deepEqual(parseCaption(`Q1-${id}`), { type: "mentee_quarterly", code: id, fullCode: `Q1-${id}`, quarter: 1 });
  assert.deepEqual(parseCaption(`my endline lesson q4 ${id}.`), { type: "mentee_quarterly", code: id, fullCode: `Q4-${id}`, quarter: 4 });
  // A cycle code still wins over a quarter written in passing.
  assert.equal(parseCaption("Q1 lesson OBS-2026-009").type, "observation_cycle");
  assert.equal(parseCaption("results for Q4").type, "generic", "a quarter with no pairing id links nothing");
});

async function withPairing(w: World, body: (p: { pairingId: string }) => Promise<void>) {
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const mentorId = await one(`INSERT INTO mentors (name) VALUES ($1) RETURNING id`, [`Mentor ${w.T}`]);
  const pairingId = await one(
    `INSERT INTO mentor_pairings (mentor_id, teacher_id, current_quarter) VALUES ($1, $2, 1) RETURNING id`,
    [mentorId, w.teacher.teacherId],
  );
  try {
    await body({ pairingId });
  } finally {
    await w.c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [pairingId]);
    await w.c.query(`DELETE FROM mentors WHERE id = $1`, [mentorId]);
  }
}

async function send(w: World, from: string, caption: string) {
  const { POST } = await route();
  const id = w.wamid();
  assert.equal((await POST(signed(envelope([videoMessage({ id, from, caption })])))).status, 200);
  return { id, sub: (await w.submission(id))! };
}

test("F50: the mentee's Q1- video reaches her pairing, with its quarter; the rules match the direct upload", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld((w) =>
      withPairing(w, async ({ pairingId }) => {
        const q1 = await send(w, w.teacher.phone, `Q1-${pairingId}`);
        assert.deepEqual([q1.sub.context_type, q1.sub.context_id, q1.sub.context_quarter], ["mentee_quarterly", pairingId, 1]);

        // Q4 is not open in Q1; kept, linked to nothing, and the refusal audited.
        const early = await send(w, w.teacher.phone, `Q4-${pairingId}`);
        assert.equal(early.sub.context_type, "generic");
        assert.equal(early.sub.context_quarter, null);
        const [a] = await waitFor(() => w.audits("whatsapp.context.forbidden", early.id), (r) => r.length >= 1);
        assert.equal((a?.metadata as { reason?: string } | undefined)?.reason, "mentee_quarterly.q4_not_open");

        // Someone off the pairing cannot put a video on it.
        const stranger = await send(w, w.otherTeacher.phone, `Q1-${pairingId}`);
        assert.equal(stranger.sub.context_type, "generic");

        await w.c.query(`UPDATE mentor_pairings SET current_quarter = 4 WHERE id = $1`, [pairingId]);
        const q4 = await send(w, w.teacher.phone, `Q4-${pairingId}`);
        assert.deepEqual([q4.sub.context_type, q4.sub.context_quarter], ["mentee_quarterly", 4]);
      }),
    ),
  );
});

test("F50: once fetched, the sender is told her quarterly video reached the pairing", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld((w) =>
      withPairing(w, async ({ pairingId }) => {
        const { fetchWhatsAppMedia } = await import("../../apps/worker/src/whatsapp-fetch.ts");
        const { job } = await acceptAndClaim(w, { caption: `Q1-${pairingId}` });
        const graph = fakeGraph();
        await fetchWhatsAppMedia(job.payload as never, { attempt: job.attempts, maxAttempts: job.maxAttempts }, {
          fetch: graph.fetch,
          put: fakeStorage().put,
          env: { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "PNID-TEST" },
        });
        assert.equal(graph.sent.length, 1, "one reply");
        assert.match(graph.sent[0]!.body, /Q1/);
        assert.match(graph.sent[0]!.body, /pairing/i);
        assert.doesNotMatch(graph.sent[0]!.body, /did not name a cycle/);
      }),
    ),
  );
});
