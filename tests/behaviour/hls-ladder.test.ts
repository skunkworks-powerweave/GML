// The adaptive ladder from the PLAYER's side: what /api/media/playlist/<id>
// hands a viewer, called exactly as Next calls it, as a signed-in admin
// (see _stubs/auth-session.ts), with Storage faked in-process (_storage.ts).
//
// The worker now writes a master playlist listing 240p/360p/480p renditions
// (encode.ts). A master's variant lines are not segments: signed as if they
// were, they became bare Storage URLs for the variant playlists, whose own
// relative segment lines then resolved against Storage with no token -- so a
// ladder would never have played. Each rendition must come back through the
// app, which signs its segments after the same authorization check.
//
// The playlist texts below are exactly what ffmpeg 7.1 writes for the ladder.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { Client } from "pg";
import "./_ui.js";
import { needsDatabase, tag, DATABASE_URL } from "./_harness.js";
import { startFakeStorage, type FakeStorage } from "./_storage.js";

const skip = needsDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (/\/tests\/behaviour\/_stubs\/auth\.ts$/.test(resolved.url.replace(/\\/g, "/"))) {
      return { url: new URL("./_stubs/auth-session.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});

const route = () => import("../../apps/web/src/app/api/media/playlist/[id]/route.ts");
const player = () => import("../../apps/web/src/components/video/HlsPlayer.tsx");

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=206423,AVERAGE-BANDWIDTH=206423,RESOLUTION=426x240,CODECS="avc1.640015,mp4a.40.2"',
  "v0.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=332007,AVERAGE-BANDWIDTH=332007,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"',
  "v1.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=594079,AVERAGE-BANDWIDTH=594079,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"',
  "v2.m3u8",
  "",
].join("\n");
const media = (seg: string) =>
  ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXTINF:4.000000,", seg, "#EXT-X-ENDLIST", ""].join("\n");

let storage: FakeStorage;
before(async () => {
  storage = await startFakeStorage();
  process.env.NEXT_PUBLIC_SUPABASE_URL = storage.url;
  process.env.SUPABASE_SECRET_KEY = "test-dummy";
});
after(async () => {
  await storage?.close();
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

/** A ready video whose hls_master_key is `key(id)`, with `objects` in Storage under hls/<id>/. */
async function withVideo(
  s: { key: (id: string) => string; objects: Record<string, string> },
  body: (id: string) => Promise<void>,
): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const t = tag("ladder");
  const [file] = (await c.query<{ id: string }>(
    `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored') RETURNING id`,
    [`test/${t}.mp4`],
  )).rows;
  const id = randomUUID();
  await c.query(
    `INSERT INTO video_submissions (id, file_id, source, status, context_type, hls_master_key, verified_at, duration_sec)
       VALUES ($1, $2, 'direct', 'ready', 'generic', $3, now(), 4)`,
    [id, file!.id, s.key(id)],
  );
  for (const [name, text] of Object.entries(s.objects)) {
    storage.put("videos-hls", `hls/${id}/${name}`, Buffer.from(text), name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
  }
  (globalThis as Record<string, unknown>).__gmlTestSession = {
    user: { id: randomUUID(), email: "admin@example.test", name: "Admin", image: null, role: "programme_admin" },
  };
  try {
    await body(id);
  } finally {
    await c.query(`DELETE FROM video_submissions WHERE id = $1`, [id]);
    await c.query(`DELETE FROM files WHERE id = $1`, [file!.id]);
    await c.end();
  }
}

async function get(id: string, query = ""): Promise<{ status: number; body: string }> {
  const { GET } = await route();
  try {
    const res = await GET(new Request(`http://app.test/api/media/playlist/${id}${query}`), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    // notFound() is Next's thrown digest.
    const digest = (e as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { status: 404, body: "" };
    throw e;
  }
}

const uriLines = (playlist: string) => playlist.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const LADDER = {
  "master.m3u8": MASTER,
  "v0.m3u8": media("v0_00000.ts"),
  "v1.m3u8": media("v1_00000.ts"),
  "v2.m3u8": media("v2_00000.ts"),
  "v0_00000.ts": "seg",
  "v1_00000.ts": "seg",
  "v2_00000.ts": "seg",
};

test("F144: a ladder's master playlist sends each rendition back through the app", { skip }, async () => {
  await withVideo({ key: (id) => `hls/${id}/master.m3u8`, objects: LADDER }, async (id) => {
    const res = await get(id);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(uriLines(res.body), [
      `/api/media/playlist/${id}?variant=v0.m3u8`,
      `/api/media/playlist/${id}?variant=v1.m3u8`,
      `/api/media/playlist/${id}?variant=v2.m3u8`,
    ]);
    // The STREAM-INF lines -- bandwidth and resolution, which ABR chooses by --
    // pass through untouched.
    assert.equal(res.body.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF")).length, 3);
  });
});

test("F144: each rendition's playlist comes back with its own segments signed", { skip }, async () => {
  await withVideo({ key: (id) => `hls/${id}/master.m3u8`, objects: LADDER }, async (id) => {
    const res = await get(id, "?variant=v1.m3u8");
    assert.equal(res.status, 200, res.body);
    const [seg] = uriLines(res.body);
    assert.ok(seg?.startsWith(storage.url), `the segment line is not a signed Storage URL: ${seg}`);
    assert.match(seg!, new RegExp(`hls/${id}/v1_00000\\.ts\\?token=`));
  });
});

test("F144: a video transcoded before the ladder still plays", { skip }, async () => {
  await withVideo(
    { key: (id) => `hls/${id}/index.m3u8`, objects: { "index.m3u8": media("seg_00000.ts"), "seg_00000.ts": "seg" } },
    async (id) => {
      const res = await get(id);
      assert.equal(res.status, 200, res.body);
      const [seg] = uriLines(res.body);
      assert.match(seg ?? "", new RegExp(`^${storage.url}.*hls/${id}/seg_00000\\.ts\\?token=`));
    },
  );
});

test("F144: a variant is a playlist name from the video's own master, never a path", { skip }, async () => {
  await withVideo({ key: (id) => `hls/${id}/master.m3u8`, objects: LADDER }, async (id) => {
    for (const bad of ["../../other/index.m3u8", "v0_00000.ts", "master.m3u8", "v0.m3u8%2F..%2Fx"]) {
      assert.equal((await get(id, `?variant=${bad}`)).status, 404, `?variant=${bad} was served`);
    }
  });
  await withVideo(
    { key: (id) => `hls/${id}/index.m3u8`, objects: { "index.m3u8": media("seg_00000.ts"), "v0.m3u8": media("x.ts") } },
    async (id) => {
      assert.equal((await get(id, "?variant=v0.m3u8")).status, 404, "a single-rendition video has no variants");
    },
  );
});

test("F144: the player's quality menu offers the ladder's renditions, and 480p pins the 480p one", async () => {
  const m = (await player()) as Record<string, unknown>;
  const options = m.renditionOptions as ((levels: { width: number; height: number }[]) => string[]) | undefined;
  const indexFor = m.levelIndexFor as ((levels: { width: number; height: number }[], choice: string) => number) | undefined;
  assert.equal(typeof options, "function", "the player has no notion of the ladder's renditions");
  const landscape = [{ width: 426, height: 240 }, { width: 640, height: 360 }, { width: 854, height: 480 }];
  const portrait = [{ width: 240, height: 426 }, { width: 360, height: 640 }, { width: 480, height: 854 }];
  assert.deepEqual(options!(landscape), ["240p", "360p", "480p"]);
  assert.deepEqual(options!(portrait), ["240p", "360p", "480p"], "a portrait rung is named by its short side");
  // The old menu set hls.currentLevel = 0 for "480p" -- in a ladder, that is 240p.
  assert.equal(indexFor!(landscape, "480p"), 2);
  assert.equal(indexFor!(portrait, "360p"), 1);
  assert.equal(indexFor!(landscape, "auto"), -1);
});
