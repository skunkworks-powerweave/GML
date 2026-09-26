// FR-37: the /videos library pages instead of stopping at the newest 100.
//
// The query ended in .limit(100) with no page control, while the status chips
// counted the whole set ("All 125"): past 100 the older videos -- including
// generic WhatsApp submissions that appear nowhere else -- could not be
// reached. The real page, rendered for a teacher whose library is exactly the
// videos seeded here.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb } from "./_server-actions.js";
import { render, withAppRouter, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

test("FR-37: the video library shows 30 a page, says which, and pages to the oldest", { skip }, async () => {
  const w = await observationWorld("vidpage");
  try {
    await w.c.query(
      `WITH f AS (
         INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id)
         SELECT 'videos-original', 'test/' || $2 || '/' || g, 'video/mp4', 'video_original', 'stored', $1
           FROM generate_series(1, 35) g
         RETURNING id, object_key
       )
       INSERT INTO video_submissions (file_id, source, status, context_type, submitted_by_user_id, created_at)
       SELECT f.id, 'direct', 'queued', 'generic', $1,
              now() - make_interval(mins => split_part(f.object_key, '/', 3)::int)
         FROM f`,
      [w.teacher.id, w.T],
    );
    const { default: VideoLibraryPage } = await import("../../apps/web/src/app/(authenticated)/videos/page.tsx");
    const page = async (sp: Record<string, string>) => {
      signIn(w.teacher);
      const html = decodeEntities(await render(withAppRouter(await VideoLibraryPage({ searchParams: Promise.resolve(sp) }))));
      const cards = new Set([...html.matchAll(/href="\/videos\/([0-9a-f-]{36})"/g)].map((m) => m[1]));
      return { html, cards };
    };

    const first = await page({});
    assert.equal(first.cards.size, 30);
    assert.match(first.html, /Showing 1–30 of 35/);
    assert.match(first.html, /href="\/videos\?page=2"[^>]*>Next/);

    const second = await page({ page: "2" });
    assert.equal(second.cards.size, 5, "the five oldest are on page 2");
    assert.match(second.html, /Showing 31–35 of 35/);
    for (const id of second.cards) assert.ok(!first.cards.has(id), "pages do not overlap");

    // A filter keeps its page links, and a stale page past the end is the last.
    const filtered = await page({ status: "queued", page: "9" });
    assert.match(filtered.html, /Showing 31–35 of 35/);
    assert.match(filtered.html, /href="\/videos\?status=queued&page=1"[^>]*>← Previous/);
  } finally {
    await w.c.query(
      `WITH v AS (DELETE FROM video_submissions WHERE submitted_by_user_id = $1 RETURNING file_id)
       DELETE FROM files WHERE id IN (SELECT file_id FROM v)`,
      [w.teacher.id],
    );
    await w.cleanup();
  }
});
