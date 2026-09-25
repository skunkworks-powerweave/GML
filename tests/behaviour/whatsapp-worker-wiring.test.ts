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

const skip = needsDatabase();
const worker = () => import("../../apps/worker/src/index.ts");

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
        await runJob(job);
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
        await runJob(await claimJob(w, String(queued!.id)));
      } finally {
        console.warn = warn;
      }
      const [row] = (await w.c.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [queued!.id])).rows;
      assert.equal(row.status, "succeeded", `the reply job ended ${row.status}: ${row.last_error ?? ""}`);
    }),
  );
});
