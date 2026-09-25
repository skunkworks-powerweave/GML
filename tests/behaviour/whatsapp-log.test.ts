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
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { render } from "./_ui.js";
import { envelope, route, SECRET, signed, videoMessage, withEnv, withWorld } from "./_whatsapp.js";

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
