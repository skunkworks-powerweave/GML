// /admin/whatsapp-log, executed: the page an operator opens when a teacher says
// "I sent it on WhatsApp", and its two actions.
//
// The page and the actions are the real modules, rendered and called the way
// Next calls them, with only the session supplied (see _stubs/auth-session.ts)
// and revalidatePath() -- which needs Next's request store -- made a no-op.
// redirect() is Next's thrown digest, read back by `outcome`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { render } from "./_ui.js";
import { envelope, route, SECRET, signed, videoMessage, withEnv, withWorld } from "./_whatsapp.js";

const skip = needsDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    // _ui.ts maps @/auth to a stub with no session; these tests need one.
    if (/\/tests\/behaviour\/_stubs\/auth\.ts$/.test(resolved.url.replace(/\\/g, "/"))) {
      return { url: new URL("./_stubs/auth-session.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
(webRequire("next/cache") as { revalidatePath: () => void }).revalidatePath = () => undefined;

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

