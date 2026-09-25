// What the video surfaces TELL people matches what the product does -- executed.
//
// ── THE DEFECT (F13, the video copy) ─────────────────────────────────────────
//
//   - Every player page said "Download is disabled; right-click is blocked.
//     Sharing the URL with others won't work — signed links are bound to your
//     network connection." The IP binding went with the old token scheme:
//     segment URLs are bearer Supabase signed URLs, valid 30 minutes to 6 hours,
//     fetchable by anyone holding the playlist, from any network. The library
//     header added "never available for direct download". For classroom
//     recordings of children, false assurances about sharing are worse than
//     none.
//   - Help said videos are transcoded to "240p, 480p, 720p and audio-only" and
//     drop to 240p on weak networks; the worker produces ONE 480p rendition. It
//     said the watermark is "drawn faintly across every frame" and would show
//     whose account a leak came from; it is a CSS overlay on the player, and a
//     fetched segment carries no attribution.
//   - The quality menu showed users an internal reference: "720p (disabled —
//     spec 041)". The player page headed itself "Video review · <uuid>".
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real components and pages rendered (the pages against Postgres), and the
// real HELP entries compared with the rendition the worker actually encodes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { renderSync, render, h, withAppRouter, decodeEntities, openingTags, attr } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

const skip = needsDatabase();
// Only a run with a database opened the app's pool; the other tests here run anywhere.
after(async () => {
  if (!skip) await closeAppDb();
});
const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** The heights the worker's HLS pass encodes (the ffmpeg run that writes -hls_time). */
function encodedHeights(): Set<string> {
  const src = readFileSync(new URL("../../apps/worker/src/transcode.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  const hlsRun = src.slice(0, src.indexOf('"-hls_time"'));
  const all = [...hlsRun.matchAll(/scale=-2:(\d+)/g)].map((m) => m[1]!);
  assert.ok(all.length > 0, "found the HLS pass's scale filter");
  return new Set([all[all.length - 1]!]);
}

test("help describes the rendition the worker actually produces, and what the watermark actually is", async () => {
  const { HELP } = await import("../../apps/web/src/lib/help.ts");
  const heights = encodedHeights();
  for (const key of ["hls", "transcoding", "watermark"]) {
    const entry = HELP[key]!;
    const said = `${entry.short} ${entry.long ?? ""}`;
    for (const m of said.matchAll(/(\d{3,4})p\b/g)) {
      assert.ok(heights.has(m[1]!), `help "${key}" promises ${m[1]}p; the worker encodes ${[...heights].join(", ")}p only`);
    }
    assert.doesNotMatch(said, /audio-only|four versions|several sizes/i, `help "${key}" promises renditions that do not exist`);
  }
  const watermark = `${HELP.watermark!.short} ${HELP.watermark!.long ?? ""}`;
  assert.doesNotMatch(watermark, /every frame|whose account it came from/i, "the watermark is an overlay on the player, not in the video");
  assert.doesNotMatch(`${HELP.hls!.short} ${HELP.hls!.long ?? ""}`, /\b2G\b/, "an 800 kbps stream does not play on 2G");
});

test("the quality menu shows no internal spec reference, and says truly why 720p is not offered", async () => {
  const { HlsPlayer } = await import("../../apps/web/src/components/video/HlsPlayer.tsx");
  const html = renderSync(h(HlsPlayer, { src: "/api/media/playlist/v1", watermark: "Mentor · now" }));
  assert.doesNotMatch(text(html), /\bspec\s*\d+/i);
  // The tooltip said "720p disabled per programme settings". No setting turns
  // it off: the worker never produces a 720p rendition.
  const option = openingTags(html, "option").find((t) => attr(t, "value") === "720p");
  assert.ok(option && /\sdisabled\b/.test(option), "the 720p row stays, disabled");
  const title = decodeEntities(attr(option, "title") ?? "");
  assert.doesNotMatch(title, /programme settings|per settings/i, `tooltip: ${title}`);
  const heights = encodedHeights();
  const named = [...title.matchAll(/(\d{3,4})p\b/g)].map((m) => m[1]!).filter((p) => p !== "720");
  assert.ok(named.length > 0 && named.every((p) => heights.has(p)), `the tooltip names what is produced (${[...heights].join(", ")}p): ${title}`);
});

test("the player and library pages make no promise the links cannot keep", { skip }, async () => {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("copy");
  const userId = (
    await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${T}@example.test`, `Teacher ${T}`])
  ).rows[0].id as string;
  const fileId = (
    await c.query(
      `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2) RETURNING id`,
      [`test/${T}.mp4`, userId],
    )
  ).rows[0].id as string;
  const videoId = (
    await c.query(
      `INSERT INTO video_submissions (file_id, source, status, context_type, submitted_by_user_id, hls_master_key, verified_at)
       VALUES ($1, 'direct', 'ready', 'teach_back', $2, 'hls/test/index.m3u8', now()) RETURNING id`,
      [fileId, userId],
    )
  ).rows[0].id as string;
  try {
    signIn({ id: userId, role: "teacher", name: `Teacher ${T}` });
    const { default: VideoPlayerPage } = await import("../../apps/web/src/app/(authenticated)/videos/[id]/page.tsx");
    const player = await render(withAppRouter(await VideoPlayerPage({ params: Promise.resolve({ id: videoId }) })));
    const playerText = text(player);
    assert.doesNotMatch(playerText, /bound to your network|won.t work|download is disabled|download disabled/i, playerText.slice(0, 400));
    assert.match(playerText, /expire/i, "say what is true: the links expire");
    const h1 = text(player.match(/<h1[^>]*>[\s\S]*?<\/h1>/)?.[0] ?? "");
    assert.doesNotMatch(h1, new RegExp(videoId), "the heading names the video, not its uuid");
    assert.match(h1, /teach.back/i);

    const { default: VideoLibraryPage } = await import("../../apps/web/src/app/(authenticated)/videos/page.tsx");
    const library = text(await render(withAppRouter(await VideoLibraryPage({ searchParams: Promise.resolve({}) }))));
    assert.doesNotMatch(library, /never available for direct download/i);
  } finally {
    await c.query(`DELETE FROM video_submissions WHERE id = $1`, [videoId]);
    await c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.end();
  }
});
