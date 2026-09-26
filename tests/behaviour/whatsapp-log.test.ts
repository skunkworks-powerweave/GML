// /admin/whatsapp-log, executed: the page an operator opens when a teacher says
// "I sent it on WhatsApp", and its two actions.
//
// The page and the actions are the real modules, rendered and called the way
// Next calls them, with only the session supplied (the @/auth stub in _ui.ts
// answers with globalThis.__gmlTestSession) and revalidatePath() recorded by
// the next/cache stub. redirect() is Next's thrown digest, read back by
// `outcome`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { render } from "./_ui.js";
import { withRowFault } from "./_fake_gotrue.js";
import { envelope, route, SECRET, signed, videoMessage, withEnv, withWorld, type World } from "./_whatsapp.js";

const skip = needsDatabase();

const actions = () => import("../../apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts");
const page = () => import("../../apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx");
const fetcher = () => import("../../apps/worker/src/whatsapp-fetch.ts");

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

function signIn(role: string): void {
  const id = randomUUID();
  (globalThis as Record<string, unknown>).__gmlTestSession = {
    user: { id, email: `${id}@example.test`, name: "Operator", image: null, role },
  };
}

async function outcome<T>(run: () => Promise<T>): Promise<{ value?: T; redirect?: string }> {
  try {
    return { value: await run() };
  } catch (e) {
    const digest = (e as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return { redirect: digest.split(";")[2] };
    throw e;
  }
}

const form = (submissionId: string) => {
  const fd = new FormData();
  fd.set("submissionId", submissionId);
  return fd;
};

const CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };

/** Deliver a video, then let every fetch attempt fail: a dead-lettered fetch. */
async function deliverAndExhaust(w: Parameters<Parameters<typeof withWorld>[0]>[0]) {
  const { POST } = await route();
  const id = w.wamid();
  assert.equal((await POST(signed(envelope([videoMessage({ id, from: w.teacher.phone, caption: w.cycleCode })])))).status, 200);
  const [job] = await w.jobs(id);
  const { fetchWhatsAppMedia } = await fetcher();
  await fetchWhatsAppMedia(job!.payload as never, { attempt: 10, maxAttempts: 10 }, { env: {}, put: async () => undefined }).catch(
    () => undefined,
  );
  // What the queue does with a job whose last attempt failed.
  await w.c.query(`UPDATE jobs SET status = 'dead', last_error = 'WHATSAPP_ACCESS_TOKEN is not set', completed_at = now() WHERE id = $1`, [
    job!.id,
  ]);
  const sub = await w.submission(id);
  assert.equal(sub!.status, "failed");
  return { id, submissionId: String(sub!.id) };
}

test("F93: a dead-lettered fetch shows its reason and can be queued again once the cause is fixed", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { id, submissionId } = await deliverAndExhaust(w);
      signIn("programme_admin");

      const { default: Page } = await page();
      const html = await render(await Page({ searchParams: Promise.resolve({}) }));
      const row = html.slice(html.indexOf(submissionId.slice(0, 10)) - 2000, html.indexOf(submissionId.slice(0, 10)) + 2000);
      assert.match(row, /WHATSAPP_ACCESS_TOKEN/, "the failure's reason must be on the page, not only in the jobs table");
      assert.match(row, /Retry fetch/, "a video whose media never arrived must be recoverable from here");

      const { retryWhatsAppFetchAction } = await actions();
      const r = await outcome(() => retryWhatsAppFetchAction(form(submissionId)));
      assert.equal(r.redirect, "/admin/whatsapp-log");

      const sub = await w.submission(id);
      assert.equal(sub!.status, "received");
      assert.equal(sub!.file_status, "uploading");
      const live = (await w.jobs(id)).filter((j) => j.status === "queued");
      assert.equal(live.length, 1, "exactly one live fetch, from the media id the submission kept");
      assert.equal((live[0]!.payload as Record<string, unknown>).mediaId, `MEDIA-${id}`);
    }),
  );
});

// ── F98: who sent it ─────────────────────────────────────────────────────────
//
// The page recovered the sender from audit rows joined on entity_id, which the
// webhook never set, so the column read "—" for every row -- and for a video
// from a number on file for nobody, the sender is the operator's only clue.

test("F98: the ingest log shows who sent each video", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      const stranger = "447700900" + String(Math.floor(Math.random() * 900) + 100);
      assert.equal((await POST(signed(envelope([videoMessage({ id, from: stranger, caption: "lesson" })])))).status, 200);
      const sub = await w.submission(id);
      signIn("programme_admin");
      const { default: Page } = await page();
      const html = await render(await Page({ searchParams: Promise.resolve({ parsing: "unmatched" }) }));
      const at = html.indexOf(String(sub!.id).slice(0, 10));
      assert.ok(at > 0, "the submission is listed");
      const row = html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
      assert.ok(row.includes(stranger), `the sender's number must be shown on the row: ${row.slice(0, 400)}`);

      // The header must not send the operator to a re-link control that does
      // not exist anywhere in the app.
      assert.doesNotMatch(html, /re-link it there/);
    }),
  );
});

test("F98: a row from before the sender was stored still shows it, from the audit row's message id", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const id = w.wamid();
      const from = "447700900" + String(Math.floor(Math.random() * 900) + 100);
      const q = async (sql: string, p: unknown[]) => (await w.c.query(sql, p)).rows[0]?.id as string;
      // The shape the old webhook wrote: no whatsapp_from, and a received-audit
      // row with no entity_id.
      const fileId = await q(
        `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored') RETURNING id`,
        [`whatsapp/${id}.mp4`],
      );
      const subId = await q(
        `INSERT INTO video_submissions (file_id, source, status, context_type, caption_raw, whatsapp_message_id)
         VALUES ($1, 'whatsapp', 'failed', 'generic', 'old', $2) RETURNING id`,
        [fileId, id],
      );
      await w.c.query(
        `INSERT INTO audit_log (action, entity_type, metadata) VALUES ('whatsapp.message.received', 'video_submission', $1)`,
        [JSON.stringify({ msgId: id, from })],
      );
      signIn("programme_admin");
      const { default: Page } = await page();
      const html = await render(await Page({ searchParams: Promise.resolve({ parsing: "unmatched" }) }));
      const at = html.indexOf(subId.slice(0, 10));
      const row = html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
      assert.ok(row.includes(from), "the audit row still names the sender, by the message id it carries");
    }),
  );
});

test("F93: Resend transcode refuses a row whose media was never fetched", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { submissionId } = await deliverAndExhaust(w);
      signIn("programme_admin");
      const { resendTranscodeAction } = await actions();
      const r = await outcome(() => resendTranscodeAction(form(submissionId)));
      assert.equal(r.redirect, "/admin/whatsapp-log?error=media_not_fetched");
      const transcodes = (await w.c.query(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`submission:${submissionId}`])).rows;
      assert.equal(transcodes.length, 0, "a transcode of an object that does not exist can only fail");
    }),
  );
});


// Both actions refuse by redirecting back with ?error=<code>, and the page read
// no `error` at all: an admin who pressed Retry fetch on a row from before the
// media id was kept saw the page reload, unchanged, with no explanation.
test("F93: a refused Retry fetch or Resend is explained on the page it lands on", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const id = w.wamid();
      const q = async (sql: string, p: unknown[]) => (await w.c.query(sql, p)).rows[0]?.id as string;
      // A row from before migration 0036: no media id to fetch again.
      const fileId = await q(
        `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'failed') RETURNING id`,
        [`whatsapp/${id}.mp4`],
      );
      const subId = await q(
        `INSERT INTO video_submissions (file_id, source, status, context_type, caption_raw, whatsapp_message_id)
         VALUES ($1, 'whatsapp', 'failed', 'generic', 'old', $2) RETURNING id`,
        [fileId, id],
      );
      signIn("programme_admin");
      const { retryWhatsAppFetchAction } = await actions();
      const r = await outcome(() => retryWhatsAppFetchAction(form(subId)));
      assert.equal(r.redirect, "/admin/whatsapp-log?error=no_media_id");

      const { default: Page } = await page();
      const alertOf = async (error: string) => {
        const html = await render(await Page({ searchParams: Promise.resolve({ error }) }));
        return /data-testid="action-error"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
      };
      const landed = await alertOf(new URL(r.redirect!, "http://x").searchParams.get("error")!);
      assert.ok(landed, "the refusal must be said on the page, not only in the URL");
      assert.match(landed!, /send it again/i, "a row with no media id can only be recovered by the sender resending");

      // Every code either action redirects with has its own explanation.
      const src = readFileSync(new URL("../../apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts", import.meta.url), "utf8");
      const codes = [...new Set([...src.matchAll(/\?error=([a-z_]+)/g)].map((m) => m[1]!))];
      assert.ok(codes.length >= 7, `found ${codes.length} error codes in actions.ts`);
      const generic = await alertOf("some_unknown_code");
      for (const code of codes) {
        const text = await alertOf(code);
        assert.ok(text && text !== generic && !text.includes(code), `?error=${code} is not explained: ${text}`);
      }
    }),
  );
});

// ── Check, then write: the actions against a row that is changing ────────────
//
// Both actions judge a row from a plain read and then write it. What runs in
// between is real: the worker committing the stored bytes, a transcode
// finishing, a pooler reset during the enqueue.

/** A WhatsApp video in `status`, with every column the two actions read. */
async function seedFetched(w: World, status: string, extra: { fileStatus?: string } = {}) {
  const id = w.wamid();
  const q = async (sql: string, p: unknown[]) => (await w.c.query(sql, p)).rows[0]?.id as string;
  const fileId = await q(
    `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', $2) RETURNING id`,
    [`whatsapp/${id}.mp4`, extra.fileStatus ?? "stored"],
  );
  const ready = status === "ready" || status === "reviewed" || status === "review_pending";
  const subId = await q(
    `INSERT INTO video_submissions (file_id, source, status, context_type, caption_raw, whatsapp_message_id, whatsapp_media_id, whatsapp_from,
                                    hls_master_key, verified_at)
     VALUES ($1, 'whatsapp', $2, 'generic', 'lesson', $3, $4, $5, $6, $7) RETURNING id`,
    [fileId, status, id, `MEDIA-${id}`, w.teacher.phone, ready ? `hls/${id}/master.m3u8` : null, ready ? new Date() : null],
  );
  return { id, subId, fileId };
}

const rowOf = async (w: World, subId: string) =>
  (
    await w.c.query(
      `SELECT v.status, f.status AS file_status FROM video_submissions v JOIN files f ON f.id = v.file_id WHERE v.id = $1`,
      [subId],
    )
  ).rows[0] as { status: string; file_status: string };

const jobsFor = async (w: World, subId: string, msgId: string) =>
  (
    await w.c.query(`SELECT name, status FROM jobs WHERE dedupe_key IN ($1, $2) ORDER BY created_at`, [
      `submission:${subId}`,
      `wa:${msgId}`,
    ])
  ).rows as Array<{ name: string; status: string }>;

/**
 * Run `action` while another transaction holds `write` uncommitted, and commit
 * it only once the action is waiting on that transaction's row lock: exactly a
 * worker (or a finishing transcode) committing between the action's read and
 * its write. Deterministic: the commit waits for the lock wait, not a sleep.
 */
async function committedDuring<T>(w: World, write: (c: Client) => Promise<void>, action: () => Promise<T>): Promise<T> {
  const side = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await side.connect();
  try {
    await side.query("BEGIN");
    await write(side);
    const pid = (await side.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    let settled = false;
    const running = action().finally(() => (settled = true));
    running.catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (!settled && Date.now() < deadline) {
      const n = (await w.c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]))
        .rows[0].n as number;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await side.query("COMMIT");
    return await running;
  } finally {
    await side.end().catch(() => undefined);
  }
}

// W3-61. Resend wrote 'queued' and then enqueued, as two statements. An
// enqueue that failed (a pooler reset, a connection blip) left the video
// 'queued' with no job behind it -- "in progress" on the teacher's page for
// good, since nothing repaired a 'queued' video.
test("W3-61: a Resend whose enqueue fails leaves the video as it was, not 'queued' with no job", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { id, subId } = await seedFetched(w, "failed");
      signIn("programme_admin");
      const { resendTranscodeAction } = await actions();
      const thrown = await withRowFault(w.c, "public.jobs", "INSERT", `NEW.dedupe_key = 'submission:${subId}'`, () =>
        outcome(() => resendTranscodeAction(form(subId))).then(
          () => null,
          (e: unknown) => e,
        ),
      );
      assert.ok(thrown instanceof Error, "the operator is shown that the Resend did not happen");
      assert.equal((await rowOf(w, subId)).status, "failed", "the video must not say 'queued' with nothing queued");
      assert.deepEqual(await jobsFor(w, subId, id), []);
    }),
  );
});

// The status write was keyed on the id alone, so a status that moved on after
// the action's read was overwritten: a transcode finishing in that window left
// a playable video 'queued' and transcoded it again.
test("W3-61: a Resend does not un-ready a video whose transcode finished after the row was read", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { id, subId } = await seedFetched(w, "transcoding");
      signIn("programme_admin");
      const { resendTranscodeAction } = await actions();
      const r = await committedDuring(
        w,
        async (c) => {
          await c.query(`UPDATE video_submissions SET status = 'ready', hls_master_key = $2, verified_at = now() WHERE id = $1`, [
            subId,
            `hls/${subId}/master.m3u8`,
          ]);
        },
        () => outcome(() => resendTranscodeAction(form(subId))),
      );
      assert.equal((await rowOf(w, subId)).status, "ready", "a finished video stays finished");
      assert.deepEqual(await jobsFor(w, subId, id), [], "and is not transcoded again");
      assert.equal(r.redirect, "/admin/whatsapp-log?error=cannot_resend_finalised");
    }),
  );
});

// W3-62. The page offers Retry fetch on every row still awaiting media,
// including one whose fetch is running. When the worker stored the bytes after
// the action's read, the action's writes -- keyed on the id alone -- put the
// submission back to 'received' and the file to 'uploading' over them. The
// row then said "awaiting media" beside a queued transcode, Resend refused it
// (media_not_fetched), and the transcode finished with the file still
// 'uploading', so the Retry fetch button stayed on a ready video.
test("W3-62: a Retry fetch does not undo a fetch the worker committed after the row was read", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { POST } = await route();
      const id = w.wamid();
      assert.equal((await POST(signed(envelope([videoMessage({ id, from: w.teacher.phone, caption: w.cycleCode })])))).status, 200);
      const sub = await w.submission(id);
      const subId = String(sub!.id);
      signIn("programme_admin");
      const { retryWhatsAppFetchAction } = await actions();

      // The worker's success transaction (whatsapp-fetch.ts), held open.
      const r = await committedDuring(
        w,
        async (c) => {
          await c.query(`UPDATE video_submissions SET status = 'queued' WHERE id = $1 AND status = 'received'`, [subId]);
          await c.query(`UPDATE files SET status = 'stored' WHERE id = $1`, [sub!.file_id]);
          await c.query(
            `INSERT INTO jobs (queue, name, payload, dedupe_key) VALUES ('transcode', 'transcode', '{}', $1)`,
            [`submission:${subId}`],
          );
        },
        () => outcome(() => retryWhatsAppFetchAction(form(subId))),
      );

      assert.deepEqual(await rowOf(w, subId), { status: "queued", file_status: "stored" }, "the worker's stored bytes stand");
      assert.equal(r.redirect, "/admin/whatsapp-log?error=already_fetched");
    }),
  );
});

// What that race left behind, and why it mattered: Retry fetch on a video that
// is ready (or reviewed) sent it back through the fetch and a transcode.
test("W3-62: Retry fetch is neither offered nor done on a video past fetching", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { id, subId } = await seedFetched(w, "ready", { fileStatus: "uploading" });
      signIn("programme_admin");
      const { default: Page } = await page();
      const html = await render(await Page({ searchParams: Promise.resolve({}) }));
      const at = html.indexOf(subId.slice(0, 10));
      assert.ok(at > 0, "the submission is listed");
      const row = html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
      assert.doesNotMatch(row, /Retry fetch/, "a ready video is not fetched again");

      const { retryWhatsAppFetchAction } = await actions();
      const r = await outcome(() => retryWhatsAppFetchAction(form(subId)));
      assert.equal(r.redirect, "/admin/whatsapp-log?error=cannot_refetch_status");
      assert.deepEqual(await rowOf(w, subId), { status: "ready", file_status: "uploading" });
      assert.deepEqual(await jobsFor(w, subId, id), []);
    }),
  );
});
