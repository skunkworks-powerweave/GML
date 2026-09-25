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
  acceptAndClaim,
  bucketAllowlist,
  deferred,
  documentMessage,
  envelope,
  fakeGraph,
  fakeStorage,
  route,
  runDeferred,
  SECRET,
  signed,
  videoMessage,
  waitFor,
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
      const replays = await waitFor(() => w.audits("whatsapp.message.replay_ignored", id), (r) => r.length >= 1);
      assert.ok(replays.length >= 1, "the replay is audited so ops can see Meta retrying");
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
      assert.equal(await w.submission(text), undefined);
      assert.equal(await w.submission(pdf), undefined, "a PDF is not a lesson video");
      const [t] = await waitFor(() => w.audits("whatsapp.message.ignored", text), (r) => r.length >= 1);
      assert.ok(t, "an ignored message must leave a row saying what arrived");
      assert.equal((t.metadata as Record<string, unknown>).type, "text");
      const p = await waitFor(() => w.audits("whatsapp.message.ignored", pdf), (r) => r.length >= 1);
      assert.equal(p.length, 1);
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

// A document's mime type is whatever the sender's phone declared. The
// videos-original bucket lists eight types (_post/005), and Supabase refuses
// any other -- deterministically, so ten retries over 42 minutes all failed the
// same way, the submission was marked failed, and the teacher was told to send
// a video again that would fail again. fakeStorage enforces that allowlist.
test("worker: a document with a video type the bucket does not list is stored and queued for transcode", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const allowed = bucketAllowlist("videos-original");
      const { VIDEOS_ORIGINAL_TYPES } = await import("../../packages/shared/src/storage/buckets.ts");
      assert.deepEqual([...VIDEOS_ORIGINAL_TYPES].sort(), [...allowed].sort(), "the worker's list is the bucket's list");
      for (const mime of ["video/x-m4v", "video/mp2t", "video/x-flv"]) {
        assert.ok(!allowed.has(mime), `${mime} is meant to be a type the bucket does not list`);
        const { id, job } = await acceptAndClaim(w, { asDocument: true, mime });
        const storage = fakeStorage();
        await fetchWhatsAppMedia(job.payload as never, { attempt: 1, maxAttempts: job.maxAttempts }, {
          fetch: fakeGraph().fetch,
          put: storage.put,
          env: { WHATSAPP_ACCESS_TOKEN: "test-token" },
        });
        assert.equal(storage.puts.length, 1, `a ${mime} lesson must reach Storage`);
        assert.ok(allowed.has(storage.puts[0]!.type), `stored as ${storage.puts[0]!.type}, which the bucket accepts`);
        const sub = await w.submission(id);
        assert.equal(sub!.status, "queued");
        assert.equal(sub!.file_status, "stored");
        assert.equal(sub!.file_mime, mime, "the type the sender declared is kept on the file row");
        const transcode = (
          await w.c.query(`SELECT 1 FROM jobs WHERE queue = 'transcode' AND dedupe_key = $1`, [`submission:${sub!.id}`])
        ).rows;
        assert.equal(transcode.length, 1, "ffmpeg reads the container itself; the transcode is queued");
      }
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

// ── Shutdown, retries and refusals (W3-64, W3-65) ────────────────────────────

const REPLIES_ON = { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "PNID-TEST" };

/**
 * Graph as fakeGraph() answers it, except that the media download never
 * answers: only its request's signal ends it. A 100 MB lesson over a slow path
 * when a deploy begins.
 */
function hangingDownload() {
  const sent: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://graph.facebook.com/") && url.endsWith("/messages")) {
      sent.push(String(JSON.parse(String(init?.body)).text?.body));
      return Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.reply" }] });
    }
    if (url.startsWith("https://graph.facebook.com/")) return Response.json({ url: "https://lookaside.fbsbx.example/media/abc" });
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

// W3-64. The fetch was given no stop signal, only its own timeouts, so a
// shutdown could not cut a download short: past the 20 s drain deadline the
// worker exited without handing the job back, and the reaper charged it an
// attempt fifteen minutes later.
test("W3-64: a shutdown cuts a fetch's download short, and its last attempt records no outcome", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { id, job } = await acceptAndClaim(w);
      const graph = hangingDownload();
      const stop = new AbortController();
      const run = fetchWhatsAppMedia(
        job.payload as never,
        { attempt: job.maxAttempts, maxAttempts: job.maxAttempts, signal: stop.signal } as never,
        { fetch: graph.fetch, put: fakeStorage().put, env: REPLIES_ON },
      );
      setTimeout(() => stop.abort(), 50);
      const ended = await Promise.race([
        run.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((r) => setTimeout(() => r("still downloading"), 5_000)),
      ]);
      assert.equal(ended, "rejected", "the download must stop when shutdown begins, not wait out its five-minute timeout");
      // The job is handed back uncounted (runJob, release()), so the re-run is
      // the real last attempt: this one must leave nothing decided.
      const sub = await w.submission(id);
      assert.equal(sub!.status, "received");
      assert.equal(sub!.file_status, "uploading");
      assert.deepEqual(graph.sent, [], "the sender is not told to send it again by an attempt that will be re-run");
      assert.deepEqual(await w.audits("whatsapp.media.fetch_failed", id), []);
    }),
  );
});

// A last attempt that fails for its own reason while the worker is going away
// is interrupted too, by runJob's rule (a failure during shutdown is released,
// uncounted). It used to mark the submission failed and send "Please send it
// again" first; the released job's re-run then found it failed, did nothing,
// and was recorded 'succeeded' -- gone from the dead-fetch count on the health
// banner.
test("W3-64: a last attempt that fails once shutdown has begun leaves the video waiting for the re-run", { skip }, async () => {
  await withEnv(PARTLY_CONFIGURED, () =>
    withWorld(async (w) => {
      const { fetchWhatsAppMedia } = await fetcher();
      const { id, job } = await acceptAndClaim(w);
      const graph = fakeGraph();
      const stop = new AbortController();
      stop.abort();
      await assert.rejects(
        fetchWhatsAppMedia(
          job.payload as never,
          { attempt: job.maxAttempts, maxAttempts: job.maxAttempts, signal: stop.signal } as never,
          { fetch: graph.fetch, put: async () => { throw new Error("Storage is going away too"); }, env: REPLIES_ON },
        ),
      );
      const sub = await w.submission(id);
      assert.equal(sub!.status, "received");
      assert.notEqual(sub!.file_status, "failed");
      assert.deepEqual(graph.sent, []);
    }),
  );
});
