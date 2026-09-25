// Poster frames reach the library cards and the player -- executed.
//
// ── THE DEFECT (F14) ─────────────────────────────────────────────────────────
//
// The worker runs a second ffmpeg pass per video, uploads posters/<id>.jpg to
// the private posters bucket and sets video_submissions.poster_key. Nothing in
// apps/web ever read poster_key or signed anything in that bucket: the library
// query did not select the column, and the one HlsPlayer call site never passed
// the `poster` prop the component already supports. So every card was a grey
// box reading "click to play" or "no preview", mentors told recordings apart by
// a truncated UUID, and the player opened black.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real pages, rendered for the uploader against Postgres. Supabase is the
// one boundary replaced: supabaseAdmin() answers with a fake whose Storage
// signs what it is asked to (the opt-in stub in _ui.ts), so the real
// signObjects runs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { stubSupabaseServer, request, render, withAppRouter, openingTags, attr } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

stubSupabaseServer();
const skip = needsDatabase();
// Only a run with a database opened the app's pool; the signing test runs anywhere.
after(async () => {
  if (!skip) await closeAppDb();
});

type SignCall = { bucket: string; keys: string[]; ttl: number };

function fakeSupabase(opts: { fail?: boolean } = {}) {
  const calls: SignCall[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (keys: string[], ttl: number) => {
          calls.push({ bucket, keys, ttl });
          if (opts.fail) return { data: null, error: { message: "storage down" } };
          return { data: keys.map((k) => ({ path: k, signedUrl: `https://storage.test/sign/${bucket}/${k}?token=t`, error: null })), error: null };
        },
      }),
    },
  };
  return { client, calls };
}

test("poster keys are signed in one batch against the posters bucket; a Storage error means no posters, not a 500", async () => {
  const { signPosterUrls } = await import("../../apps/web/src/lib/video/storage.ts");
  const ok = fakeSupabase();
  request.supabaseAdmin = ok.client;
  const urls = await signPosterUrls(["a.jpg", null, "b.jpg", undefined, "a.jpg"]);
  assert.equal(ok.calls.length, 1, "one round trip for the whole page");
  assert.equal(ok.calls[0]!.bucket, "posters");
  assert.deepEqual(ok.calls[0]!.keys, ["a.jpg", "b.jpg"], "nulls skipped, duplicates once");
  assert.equal(urls.get("a.jpg"), "https://storage.test/sign/posters/a.jpg?token=t");

  request.supabaseAdmin = fakeSupabase({ fail: true }).client;
  const none = await signPosterUrls(["a.jpg"]);
  assert.equal(none.size, 0);

  const empty = fakeSupabase();
  request.supabaseAdmin = empty.client;
  assert.equal((await signPosterUrls([null])).size, 0);
  assert.equal(empty.calls.length, 0, "nothing to sign, no request");
});

async function withVideos(body: (w: { c: Client; user: { id: string; role: string; name: string }; withPoster: string; without: string }) => Promise<void>) {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("post");
  const userId = (
    await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${T}@example.test`, `Teacher ${T}`])
  ).rows[0].id as string;
  const fileId = (
    await c.query(
      `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2) RETURNING id`,
      [`test/${T}.mp4`, userId],
    )
  ).rows[0].id as string;
  const video = async (poster: boolean) =>
    (
      await c.query(
        `INSERT INTO video_submissions (file_id, source, status, context_type, submitted_by_user_id, hls_master_key, verified_at, poster_key)
         VALUES ($1, 'direct', 'ready', 'generic', $2, 'hls/test/index.m3u8', now(), CASE WHEN $3 THEN gen_random_uuid()::text || '.jpg' END)
         RETURNING id`,
        [fileId, userId, poster],
      )
    ).rows[0].id as string;
  try {
    await body({ c, user: { id: userId, role: "teacher", name: `Teacher ${T}` }, withPoster: await video(true), without: await video(false) });
  } finally {
    await c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [userId]);
    await c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.end();
  }
}

const posterKeyOf = async (c: Client, id: string) =>
  (await c.query(`SELECT poster_key FROM video_submissions WHERE id = $1`, [id])).rows[0].poster_key as string;

test("the library card shows the poster frame, lazily, and keeps the placeholder without one", { skip }, async () => {
  await withVideos(async ({ c, user, withPoster, without }) => {
    request.supabaseAdmin = fakeSupabase().client;
    signIn(user);
    const { default: VideoLibraryPage } = await import("../../apps/web/src/app/(authenticated)/videos/page.tsx");
    const html = await render(withAppRouter(await VideoLibraryPage({ searchParams: Promise.resolve({}) })));
    const card = (id: string) => html.match(new RegExp(`<a[^>]*href="/videos/${id}"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? "";
    const img = openingTags(card(withPoster), "img")[0];
    assert.ok(img, "a ready video with a poster shows it");
    assert.equal(attr(img, "src"), `https://storage.test/sign/posters/${await posterKeyOf(c, withPoster)}?token=t`);
    assert.equal(attr(img, "loading"), "lazy", "fetched only when scrolled into view: 2G phones");
    assert.equal(openingTags(card(without), "img").length, 0);
    assert.match(card(without), /click to play/);
  });
});

test("the player opens on the poster frame", { skip }, async () => {
  await withVideos(async ({ c, user, withPoster }) => {
    request.supabaseAdmin = fakeSupabase().client;
    signIn(user);
    const { default: VideoPlayerPage } = await import("../../apps/web/src/app/(authenticated)/videos/[id]/page.tsx");
    const html = await render(withAppRouter(await VideoPlayerPage({ params: Promise.resolve({ id: withPoster }) })));
    const video = openingTags(html, "video")[0] ?? "";
    assert.equal(attr(video, "poster"), `https://storage.test/sign/posters/${await posterKeyOf(c, withPoster)}?token=t`);
  });
});
