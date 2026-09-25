// The worker's wiring for WhatsApp jobs, executed.
//
// ── THE GAP (F93) ────────────────────────────────────────────────────────────
//
// Every WhatsApp video is a 'whatsapp_fetch' job on the 'whatsapp' queue, and
// every answer to a non-video a 'whatsapp_reply' job. Nothing tested that the
// worker claims that queue or dispatches those names: with the whatsapp
// consumer and the whatsapp_fetch case both deleted from
// apps/worker/src/index.ts, every test stayed green -- and every WhatsApp video
// would have sat "awaiting media" forever.
//
// Here the worker's own runJob() runs real claimed jobs, and the consumer
// plan main() starts is checked against every queue the code can enqueue on.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { acceptAndClaim, claimJob, envelope, route, SECRET, signed, withEnv, withWorld } from "./_whatsapp.js";
import { withWorkerWorld, waitFor } from "./_worker.js";
import { replyText } from "../../packages/shared/src/whatsapp/replies.ts";

const skip = needsDatabase();
const worker = () => import("../../apps/worker/src/index.ts");
// The locked_by claimJob() writes. runJob() hands a job interrupted by
// shutdown back with release(), which matches on it.
const CLAIMED_BY = "test-worker";

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

test("F93: the worker starts a consumer for every queue, the WhatsApp one included", async () => {
  const { consumerSlots } = await worker();
  const { QUEUE_NAMES } = await import("../../packages/db/src/queue.ts");
  const { WHATSAPP_QUEUE } = await import("../../packages/shared/src/whatsapp/fetch-job.ts");
  const started = new Set(consumerSlots().map((s) => s.queue));
  for (const q of QUEUE_NAMES) assert.ok(started.has(q), `jobs enqueued on '${q}' would never be claimed`);
  assert.ok(started.has(WHATSAPP_QUEUE), "WhatsApp fetches and replies are enqueued here");
});

test("F93: a claimed whatsapp_fetch job runs the fetch, and its failure is recorded for a retry", { skip }, async () => {
  // Storage credentials are local dummies and nothing is contacted: the fetch
  // stops at the missing access token, before any network call.
  await withEnv(
    {
      WHATSAPP_APP_SECRET: SECRET,
      WHATSAPP_ACCESS_TOKEN: undefined,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SECRET_KEY: "local-test-key",
    },
    () =>
      withWorld(async (w) => {
        const { runJob } = await worker();
        const { job } = await acceptAndClaim(w);
        await runJob(job, CLAIMED_BY);
        const [row] = (await w.c.query(`SELECT status, last_error, attempts FROM jobs WHERE id = $1`, [job.id])).rows;
        assert.equal(row.status, "queued", "a failed first attempt is retried, not dead-lettered");
        assert.match(String(row.last_error), /WHATSAPP_ACCESS_TOKEN/, "the fetch handler ran (not 'unknown job name')");
      }),
  );
});

test("F93: a claimed whatsapp_reply job is dispatched to the reply sender", { skip }, async () => {
  // Replies not configured: the sender is a logged no-op, and the job succeeds.
  await withEnv({ WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined }, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      await POST(signed(envelope([{ from: w.teacher.phone, id, timestamp: "1", type: "text", text: { body: "hello" } }])));
      const [queued] = (await w.jobs(id)).filter((j) => j.name === "whatsapp_reply");
      assert.ok(queued, "the webhook queued a reply");
      const { runJob } = await worker();
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        await runJob(await claimJob(w, String(queued!.id)), CLAIMED_BY);
      } finally {
        console.warn = warn;
      }
      const [row] = (await w.c.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [queued!.id])).rows;
      assert.equal(row.status, "succeeded", `the reply job ended ${row.status}: ${row.last_error ?? ""}`);
    }),
  );
});

// W3-63. A worker killed during a fetch's LAST attempt: the lease reaper
// dead-letters the job, but its only repair hook was the transcode one, and the
// fetch's own final bookkeeping -- mark the submission and its file failed,
// tell the sender -- lives in the handler's catch, which a killed process never
// runs. The video said "Received. Waiting for the worker to pick it up." for
// good, and the sender heard nothing. Run through the REAL worker, whose
// housekeeping reaps at startup with the hook it is given in production.
test(
  "W3-63: a fetch the lease reaper dead-letters is failed, audited, and its sender told",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const seed = async (attempts: number) => {
        const msgId = `wamid.${w.schema}.${attempts}`;
        const from = "919" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
        const [f] = await w.q<{ id: string }>(
          `INSERT INTO ${w.schema}.files (bucket, object_key, mime_type, kind, status)
             VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'uploading') RETURNING id`,
          [`whatsapp/${msgId}.mp4`],
        );
        const [v] = await w.q<{ id: string }>(
          `INSERT INTO ${w.schema}.video_submissions (file_id, source, status, context_type, whatsapp_message_id, whatsapp_media_id, whatsapp_from)
             VALUES ($1, 'whatsapp', 'received', 'generic', $2, $3, $4) RETURNING id`,
          [f!.id, msgId, `MEDIA-${msgId}`, from],
        );
        const payload = {
          msgId,
          videoSubmissionId: v!.id,
          fileId: f!.id,
          bucket: "videos-original",
          objectKey: `whatsapp/${msgId}.mp4`,
          mediaId: `MEDIA-${msgId}`,
          mimeType: "video/mp4",
          sha256: null,
          from,
        };
        // Claimed by a worker that then died: running, its lease lapsed.
        await w.q(
          `INSERT INTO ${w.schema}.jobs (queue, name, payload, status, attempts, max_attempts, dedupe_key, locked_by, lease_expires_at)
             VALUES ('whatsapp', 'whatsapp_fetch', $1, 'running', $2, 10, $3, 'a-worker-that-was-killed', now() - interval '1 minute')`,
          [JSON.stringify(payload), attempts, `wa:${msgId}`],
        );
        return { msgId, from, submissionId: v!.id };
      };
      const last = await seed(10);
      // The control: killed with attempts left, so it is retried, not failed.
      const retried = await seed(3);
      const row = async (id: string) =>
        (
          await w.q<{ status: string; processing_log: string | null; file_status: string }>(
            `SELECT v.status, v.processing_log, f.status AS file_status
               FROM ${w.schema}.video_submissions v JOIN ${w.schema}.files f ON f.id = v.file_id WHERE v.id = $1`,
            [id],
          )
        )[0]!;

      // Nothing may reach Meta: with replies not configured the reply job is
      // the logged no-op, and the retried fetch stops at the missing token.
      const worker = w.spawnWorker({ WHATSAPP_ACCESS_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "" });
      const failed = await waitFor(async () => (await row(last.submissionId)).status === "failed", 30_000);
      assert.ok(failed, `the dead fetch's video stayed ${JSON.stringify(await row(last.submissionId))}\n${worker.output()}`);

      const v = await row(last.submissionId);
      assert.equal(v.file_status, "failed");
      assert.match(v.processing_log ?? "", /stopped responding/i, "the reason is on the row /admin/whatsapp-log shows");
      const audits = await w.q<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM public.audit_log WHERE action = 'whatsapp.media.fetch_failed' AND entity_id = $1`,
        [last.submissionId],
      );
      assert.equal(audits.length, 1, "one fetch_failed row, as the handler's own last attempt writes");
      assert.equal(audits[0]!.metadata.msgId, last.msgId);
      const replies = await w.q<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM ${w.schema}.jobs WHERE name = 'whatsapp_reply' AND payload->>'msgId' = $1`,
        [last.msgId],
      );
      assert.equal(replies.length, 1, "the sender is told, through a queued reply");
      assert.equal(replies[0]!.payload.to, last.from);
      assert.equal(replies[0]!.payload.body, replyText({ kind: "fetch_failed" }));

      assert.equal((await row(retried.submissionId)).status, "received", "a fetch with attempts left is retried, not failed");
      assert.doesNotMatch(worker.output(), /could not repair/i);
    });
  },
);
