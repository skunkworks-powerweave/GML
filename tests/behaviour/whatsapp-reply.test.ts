// Telling the sender what happened to her video, executed.
//
// ── THE DEFECT (F140) ────────────────────────────────────────────────────────
//
// There was no outbound WhatsApp call anywhere in the repository, and
// WHATSAPP_PHONE_NUMBER_ID was read by nothing. A teacher who sent a lesson
// over 2G got the same silence whether it was linked to her cycle, parked for
// an admin because the caption did not match, attributed to nobody because
// her number was not on file, refused for its type, or lost to a failed
// download -- and found out only when the cycle stalled.
//
// Replies go through the Cloud API messages endpoint once the outcome is
// known. With WhatsApp not configured (the state the programme starts in),
// they are a logged no-op and nothing else changes. Graph is the one thing
// replaced here, through the same seam the fetch uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";
import {
  acceptAndClaim,
  claimJob,
  envelope,
  fakeGraph,
  fakeStorage,
  route,
  SECRET,
  signed,
  withEnv,
  withWorld,
} from "./_whatsapp.js";

const skip = needsDatabase();
const fetcher = () => import("../../apps/worker/src/whatsapp-fetch.ts");

const CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };
const REPLIES_ON = { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "PNID-TEST" };

test("F140: the reply builder is a no-op without credentials and a correct Cloud API call with them", async () => {
  const { sendWhatsAppText } = await import("../../packages/shared/src/whatsapp/graph.ts");
  const graph = fakeGraph();
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const off = await sendWhatsAppText({ to: "919999911111", body: "hi" }, { fetch: graph.fetch, env: {} });
    assert.deepEqual(off, { sent: false, reason: "not_configured" });
    assert.equal(graph.calls.length, 0, "nothing leaves the process while WhatsApp is not configured");
  } finally {
    console.warn = warn;
  }

  const on = await sendWhatsAppText({ to: "+91 99999 11111", body: "Received" }, { fetch: graph.fetch, env: REPLIES_ON });
  assert.deepEqual(on, { sent: true });
  const [call] = graph.calls;
  assert.equal(call!.method, "POST");
  assert.match(call!.url, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/PNID-TEST\/messages$/);
  assert.equal(call!.auth, "Bearer test-token");
  assert.ok(call!.hasSignal, "a hung Graph call must not hold the worker");
  assert.deepEqual(call!.body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "919999911111",
    type: "text",
    text: { preview_url: false, body: "Received" },
  });

  const refused = await sendWhatsAppText(
    { to: "919999911111", body: "x" },
    { fetch: fakeGraph({ send: Response.json({ error: { code: 131047, message: "Re-engagement message" } }, { status: 400 }) }).fetch, env: REPLIES_ON },
  );
  assert.equal(refused.sent, false, "a refused send is reported, never thrown");
});

test("F140: a fetched video is acknowledged to its sender, naming the cycle it reached", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { job } = await acceptAndClaim(w);
      const graph = fakeGraph();
      await fetchWhatsAppMedia(job.payload as never, { attempt: job.attempts, maxAttempts: job.maxAttempts }, {
        fetch: graph.fetch,
        put: fakeStorage().put,
        env: REPLIES_ON,
      });
      assert.equal(graph.sent.length, 1, "the sender must hear that the video arrived");
      assert.equal(graph.sent[0]!.to, w.teacher.phone);
      assert.ok(graph.sent[0]!.body.includes(w.cycleCode), `the reply must say which cycle: ${graph.sent[0]!.body}`);
    }),
  );
});

test("F140: an unmatched caption and an unknown number each get a reply saying what to do", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const run = async (opts: { caption?: string; from?: string }) => {
        const { job } = await acceptAndClaim(w, opts);
        const graph = fakeGraph();
        await fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, {
          fetch: graph.fetch,
          put: fakeStorage().put,
          env: REPLIES_ON,
        });
        assert.equal(graph.sent.length, 1);
        return graph.sent[0]!.body;
      };
      assert.match(await run({ caption: "my lesson" }), /OBS-\d{4}-\d{3}/, "an unmatched caption is told the format that works");
      assert.match(await run({ from: "447700900555" }), /not registered/i, "an unknown number is told why nothing was linked");
    }),
  );
});

test("F140: a video that could not be fetched is reported to its sender on the last attempt", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { job } = await acceptAndClaim(w);
      const down = () => fakeGraph({ meta: new Response("upstream", { status: 503 }) });
      const early = down();
      await assert.rejects(
        fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, { fetch: early.fetch, put: fakeStorage().put, env: REPLIES_ON }),
      );
      assert.equal(early.sent.length, 0, "an attempt that will be retried says nothing yet");
      const last = down();
      await assert.rejects(
        fetchWhatsAppMedia(job.payload as never, { attempt: job.maxAttempts, maxAttempts: job.maxAttempts }, { fetch: last.fetch, put: fakeStorage().put, env: REPLIES_ON }),
      );
      assert.equal(last.sent.length, 1);
      assert.match(last.sent[0]!.body, /send it again/i);
    }),
  );
});

test("F140: with replies not configured, the fetch still completes and nothing is sent", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { id, job } = await acceptAndClaim(w);
      const graph = fakeGraph();
      await fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, {
        fetch: graph.fetch,
        put: fakeStorage().put,
        env: { WHATSAPP_ACCESS_TOKEN: "test-token" }, // no phone number id
      });
      assert.equal(graph.sent.length, 0);
      assert.equal((await w.submission(id))!.status, "queued");
    }),
  );
});

test("F140: a message that is not a video is answered with what the number accepts", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      const res = await POST(signed(envelope([{ from: w.teacher.phone, id, timestamp: "1", type: "text", text: { body: "hello" } }])));
      assert.equal(res.status, 200);
      const [reply] = (await w.jobs(id)).filter((j) => j.name === "whatsapp_reply");
      assert.ok(reply, "the answer is queued, so the webhook stays fast and the reply survives a restart");
      const job = await claimJob(w, String(reply!.id));
      const { runWhatsAppReply } = await fetcher();
      const graph = fakeGraph();
      await runWhatsAppReply(job.payload as never, { fetch: graph.fetch, env: REPLIES_ON });
      assert.equal(graph.sent.length, 1);
      assert.equal(graph.sent[0]!.to, w.teacher.phone);
      assert.match(graph.sent[0]!.body, /video/i);
    }),
  );
});

// Another automated number that answers every message -- a business's
// auto-reply, a bot -- would answer "this number accepts lesson videos" with a
// text, get the same answer back, and so on, for as long as both numbers stay
// up: one reply job per message, deduped only per message id.
test("F140: a sender who keeps sending texts gets one automatic answer, not one per message", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const ids = [w.wamid(), w.wamid(), w.wamid(), w.wamid()];
      for (const id of ids) {
        const res = await POST(signed(envelope([{ from: w.teacher.phone, id, timestamp: "1", type: "text", text: { body: "Thank you for your message!" } }])));
        assert.equal(res.status, 200);
      }
      const replies = [];
      for (const id of ids) replies.push(...(await w.jobs(id)).filter((j) => j.name === "whatsapp_reply"));
      assert.equal(replies.length, 1, `${ids.length} texts from one number queued ${replies.length} automatic replies`);
    }),
  );
});

// Meta delivers a message it could not hand over as type 'unsupported'. It was
// audited and then nothing: the teacher, who did try to send something, heard
// nothing at all.
test("F140: a message WhatsApp could not deliver is answered with how to send the video", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      const unsupported = {
        from: w.teacher.phone,
        id,
        timestamp: "1",
        type: "unsupported",
        errors: [{ code: 131051, title: "Message type unknown", message: "Message type unknown" }],
      };
      assert.equal((await POST(signed(envelope([unsupported])))).status, 200);
      const [reply] = (await w.jobs(id)).filter((j) => j.name === "whatsapp_reply");
      assert.ok(reply, "the sender must hear that the message did not arrive");
      const body = String((reply!.payload as Record<string, unknown>).body);
      assert.match(body, /could not/i);
      assert.match(body, /document/i, "a lesson over 16 MB has to be sent as a document");
      assert.match(body, /100 MB/);
    }),
  );
});
