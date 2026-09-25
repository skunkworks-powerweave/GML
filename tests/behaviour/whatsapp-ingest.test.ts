// The WhatsApp webhook, executed: what is durable at the moment Meta is told
// "200, delivered".
//
// ── THE DEFECT (F93) ─────────────────────────────────────────────────────────
//
// The handler answered {ok:true} and did ALL of the work later, inside
// after(): the Graph lookup, the download, the Storage put and the
// video_submissions insert. Meta only redelivers a webhook that did not get a
// 2xx, so from that moment the teacher's recording existed only in a closure.
// A blank or expired WHATSAPP_ACCESS_TOKEN, a Graph 5xx, a Storage error or a
// container restart lost it for good -- no submission, no job, and not even the
// Graph media id recorded anywhere to fetch it again. A video sent through
// WhatsApp's Document picker (how a lesson over 16 MB has to travel) was
// skipped before any audit row at all.
//
// So these assertions are made at the moment POST returns, with the deferred
// work NOT run: whatever the teacher sent must already be a row, and the fetch
// must already be a job on the Postgres queue, where it retries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";
import {
  deferred,
  documentMessage,
  envelope,
  route,
  runDeferred,
  SECRET,
  settle,
  signed,
  videoMessage,
  withEnv,
  withWorld,
} from "./_whatsapp.js";

const skip = needsDatabase();

// The state docker-compose accepts: the secret is set, the token is not.
const PARTLY_CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };

test("a signed video is a submission and a queued fetch job before Meta gets its 200", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      const res = await POST(signed(envelope([videoMessage({ id, from: w.teacher.phone, caption: w.cycleCode })])));
      assert.equal(res.status, 200);

      // Nothing deferred is run: this is the state a restart would leave.
      const sub = await w.submission(id);
      assert.ok(sub, "the recording must be a video_submissions row by the time Meta is acknowledged");
      assert.equal(sub.source, "whatsapp");
      assert.equal(sub.status, "received", "received = accepted, bytes not yet fetched");
      assert.equal(sub.whatsapp_media_id, `MEDIA-${id}`, "the Graph media id is what a retry needs; it must be kept");
      assert.equal(sub.file_status, "uploading", "the files row exists but holds no bytes yet");

      const jobs = await w.jobs(id);
      assert.equal(jobs.length, 1, "exactly one fetch job, so the work survives a restart and is retried");
      assert.equal(jobs[0]!.queue, "whatsapp");
      assert.equal(jobs[0]!.name, "whatsapp_fetch");
      assert.equal(jobs[0]!.status, "queued");
      assert.equal(jobs[0]!.dedupe_key, `wa:${id}`);
      assert.ok(Number(jobs[0]!.max_attempts) > 3, "a Graph outage or a token rotation needs more than 15 seconds of retries");

      assert.equal(deferred.length, 0, "no ingest work may be left to after(), where a failure is final");
    }),
  );
});

test("a redelivered message is a replay, not a second submission or a second job", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      const body = envelope([videoMessage({ id, from: w.teacher.phone, caption: w.cycleCode })]);
      assert.equal((await POST(signed(body))).status, 200);
      assert.equal((await POST(signed(body))).status, 200);
      await runDeferred();
      const n = Number((await w.c.query(`SELECT count(*) AS n FROM video_submissions WHERE whatsapp_message_id = $1`, [id])).rows[0].n);
      assert.equal(n, 1);
      assert.equal((await w.jobs(id)).length, 1);
      await settle();
      assert.ok((await w.audits("whatsapp.message.replay_ignored", id)).length >= 1, "the replay is audited so ops can see Meta retrying");
    }),
  );
});

test("a video sent as a WhatsApp document is ingested like any other video", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      const res = await POST(
        signed(envelope([documentMessage({ id, from: w.teacher.phone, caption: w.cycleCode, mime: "video/quicktime" })])),
      );
      assert.equal(res.status, 200);
      await runDeferred();
      const sub = await w.submission(id);
      assert.ok(sub, "a lesson over 16 MB can only arrive as a document; dropping it loses exactly the long recordings");
      assert.equal(sub.file_mime, "video/quicktime");
      assert.equal(sub.whatsapp_media_id, `MEDIA-${id}`);
      assert.equal((await w.jobs(id)).length, 1);
    }),
  );
});

test("a message that is not a video is audited as ignored, not dropped without trace", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const text = w.wamid();
      const pdf = w.wamid();
      const res = await POST(
        signed(
          envelope([
            { from: w.teacher.phone, id: text, timestamp: "1", type: "text", text: { body: "hello" } },
            documentMessage({ id: pdf, from: w.teacher.phone, mime: "application/pdf" }),
          ]),
        ),
      );
      assert.equal(res.status, 200);
      await runDeferred();
      await settle();
      assert.equal(await w.submission(text), undefined);
      assert.equal(await w.submission(pdf), undefined, "a PDF is not a lesson video");
      const [t] = await w.audits("whatsapp.message.ignored", text);
      assert.ok(t, "an ignored message must leave a row saying what arrived");
      assert.equal((t.metadata as Record<string, unknown>).type, "text");
      assert.ok((await w.audits("whatsapp.message.ignored", pdf)).length === 1);
    }),
  );
});

// ── The worker's half: fetching what the webhook recorded ────────────────────
//
// Graph and Storage are the two things replaced, through the handler's own
// dependency seam; everything between them -- the claim from the queue, the
// row updates, the transcode enqueue, the failure bookkeeping -- is the real
// code against the real database.

const fetcher = () => import("../../apps/worker/src/whatsapp-fetch.ts");
const queue = () => import("../../packages/db/src/queue.ts");

type Call = { url: string; hasSignal: boolean; auth: string | null };

/** Graph and Meta's media CDN, answering from a script. */
function fakeGraph(script: { meta?: Response; media?: Response } = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, hasSignal: init?.signal instanceof AbortSignal, auth: headers.get("authorization") });
    if (url.startsWith("https://graph.facebook.com/")) {
      return script.meta ?? Response.json({ url: "https://lookaside.fbsbx.example/media/abc" });
    }
    return (
      script.media ??
      new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } })
    );
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function fakeStorage() {
  const puts: Array<{ bucket: string; key: string; bytes: number; type: string }> = [];
  const put = async (bucket: string, key: string, body: Uint8Array, type: string) => {
    puts.push({ bucket, key, bytes: body.byteLength, type });
  };
  return { puts, put };
}

type W = Parameters<Parameters<typeof withWorld>[0]>[0];

/** Accept a message through the real webhook and claim its fetch job. */
async function acceptAndClaim(w: W, caption = w.cycleCode) {
  const { POST } = await route();
  const id = w.wamid();
  assert.equal((await POST(signed(envelope([videoMessage({ id, from: w.teacher.phone, caption })])))).status, 200);
  const { db } = await import("../../packages/db/src/client.ts");
  const { claim } = await queue();
  const [ours] = await w.jobs(id);
  assert.ok(ours, "the webhook queued a fetch");
  // Claim through the real queue. Another file's job could be ahead of ours in
  // a shared database, so put ours at the front.
  await w.c.query(`UPDATE jobs SET run_at = now() - interval '1 day' WHERE id = $1`, [ours!.id]);
  const job = await claim(db as never, "whatsapp", "test-worker");
  assert.equal(job?.id, ours!.id, "the fetch job is claimable from the whatsapp queue");
  return { id, job: job! };
}

test("worker: a fetch stores the bytes, marks the file stored and queues the transcode", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { id, job } = await acceptAndClaim(w);
      const graph = fakeGraph();
      const storage = fakeStorage();
      await fetchWhatsAppMedia(job.payload as never, { attempt: job.attempts, maxAttempts: job.maxAttempts }, {
        fetch: graph.fetch,
        put: storage.put,
        env: { WHATSAPP_ACCESS_TOKEN: "test-token" },
      });

      assert.equal(graph.calls.length, 2, "one Graph lookup, one download");
      assert.ok(graph.calls[0]!.url.endsWith(`/MEDIA-${id}`), "looked up by the media id the webhook kept");
      assert.ok(graph.calls.every((c) => c.hasSignal), "both calls carry a timeout; a hung Graph call must not hold the worker");
      assert.ok(graph.calls.every((c) => c.auth === "Bearer test-token"));
      assert.deepEqual(storage.puts.map((p) => p.key), [`whatsapp/${id}.mp4`]);

      const sub = await w.submission(id);
      assert.equal(sub!.status, "queued");
      assert.equal(sub!.file_status, "stored");
      const transcode = (
        await w.c.query(`SELECT status FROM jobs WHERE queue = 'transcode' AND dedupe_key = $1`, [`submission:${sub!.id}`])
      ).rows;
      assert.equal(transcode.length, 1, "the transcode is queued once the bytes exist, not before");
    }),
  );
});

test("worker: an unset token fails the attempt by name, and the last attempt marks the submission failed", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { id, job } = await acceptAndClaim(w);
      const graph = fakeGraph();
      const deps = { fetch: graph.fetch, put: fakeStorage().put, env: {} };

      await assert.rejects(
        fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, deps),
        /WHATSAPP_ACCESS_TOKEN/,
        "the failure must name the missing variable, or an operator reads it as a Meta outage",
      );
      assert.equal((await w.submission(id))!.status, "received", "an attempt that will be retried leaves the row waiting");

      await assert.rejects(
        fetchWhatsAppMedia(job.payload as never, { attempt: job.maxAttempts, maxAttempts: job.maxAttempts }, deps),
      );
      const sub = await w.submission(id);
      assert.equal(sub!.status, "failed", "a fetch that never succeeds is a visible failure, not a vanished video");
      assert.equal(sub!.file_status, "failed");
      assert.match(String(sub!.processing_log), /WHATSAPP_ACCESS_TOKEN/);
      assert.equal(graph.calls.length, 0, "nothing is sent to Graph without a token");
    }),
  );
});

test("worker: a Graph rejection carries its HTTP status and Graph error code", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { job } = await acceptAndClaim(w);
      const expired = Response.json(
        { error: { code: 190, message: "Error validating access token: Session has expired" } },
        { status: 401 },
      );
      await assert.rejects(
        fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, {
          fetch: fakeGraph({ meta: expired }).fetch,
          put: fakeStorage().put,
          env: { WHATSAPP_ACCESS_TOKEN: "stale" },
        }),
        (err: Error) => /HTTP 401/.test(err.message) && /190/.test(err.message) && /expired/i.test(err.message),
      );
    }),
  );
});

test("worker: an HTML error page is refused, not stored as a video", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { id, job } = await acceptAndClaim(w);
      const storage = fakeStorage();
      await assert.rejects(
        fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, {
          fetch: fakeGraph({ media: new Response("<html>Sorry</html>", { headers: { "content-type": "text/html" } }) }).fetch,
          put: storage.put,
          env: { WHATSAPP_ACCESS_TOKEN: "t" },
        }),
        /text\/html/,
      );
      assert.equal(storage.puts.length, 0);
      assert.equal((await w.submission(id))!.file_status, "uploading");
    }),
  );
});
