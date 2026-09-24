// /observation lists EVERY cycle the viewer can see, a page at a time.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The row query was `.orderBy(desc(scheduled_at)).limit(80)` with no page,
// cursor or search parameter, while the status and kind chips counted every
// visible row. Past 80 cycles -- a first term, for a programme of a few
// hundred teachers -- the chips promised more than the table showed, nothing
// said rows were missing, and there was no way to reach them. The sort key
// was not unique either (seeded cycles share dates; NULLs sort first), so even
// the capped slice was not a stable window.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL list page, rendered for a teacher (whose visibility is her own
// cycles, so other suites' rows cannot leak into the counts), page by page.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

async function listPage(user: TestUser, sp: Record<string, string>) {
  signIn(user);
  const { default: ObservationListPage } = await import("../../apps/web/src/app/(authenticated)/observation/page.tsx");
  const html = await render(withAppRouter(await ObservationListPage({ searchParams: Promise.resolve(sp) })));
  const ids = [...html.matchAll(/href="\/observation\/([0-9a-f-]{36})"/g)].map((m) => m[1]!);
  const text = html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  return { html, ids, text };
}

test("every one of 85 visible cycles is reachable from the list, each exactly once", { skip }, async () => {
  const w = await observationWorld("obslist");
  try {
    // 40 share one date, 5 have none: the order must still be total.
    await w.c.query(
      `INSERT INTO observation_cycles (code, teacher_id, kind, status, scheduled_at)
       SELECT $1 || '-L' || g, $2, 'baseline', 'complete',
              CASE WHEN g <= 40 THEN timestamptz '2026-06-01 10:00+00'
                   WHEN g <= 45 THEN NULL
                   ELSE timestamptz '2026-06-01 10:00+00' + make_interval(days => g) END
         FROM generate_series(1, 85) g`,
      [w.T, w.teacherId],
    );
    await w.grant(w.teacher.id);

    const seen: string[] = [];
    const first = await listPage(w.teacher, {});
    assert.match(first.text, /All 85/, "the chip counts all 85");
    assert.ok(first.ids.length < 85, "one page does not hold everything");
    assert.match(first.text, new RegExp(`Showing 1–${first.ids.length} of 85`), "the table says how much it shows");
    seen.push(...first.ids);

    let page = 1;
    let current = first;
    while (/href="\/observation\?page=\d+"[^>]*>\s*Next/.test(current.html)) {
      page += 1;
      assert.ok(page < 10, "paging terminates");
      current = await listPage(w.teacher, { page: String(page) });
      seen.push(...current.ids);
    }
    assert.equal(seen.length, 85, `every cycle appears once across the pages (saw ${seen.length})`);
    assert.equal(new Set(seen).size, 85, "no cycle appears twice");
  } finally {
    await w.cleanup();
  }
});

test("a chip keeps its filter across pages, and changing a chip starts again at page 1", { skip }, async () => {
  const w = await observationWorld("obslistf");
  try {
    await w.c.query(
      `INSERT INTO observation_cycles (code, teacher_id, kind, status, scheduled_at)
       SELECT $1 || '-F' || g, $2, 'baseline', CASE WHEN g % 2 = 0 THEN 'complete' ELSE 'observed' END::observation_status, now()
         FROM generate_series(1, 120) g`,
      [w.T, w.teacherId],
    );
    await w.grant(w.teacher.id);
    const p1 = await listPage(w.teacher, { status: "complete" });
    assert.match(p1.text, /of 60/, "60 complete cycles");
    assert.match(p1.html, /href="\/observation\?status=complete&amp;page=2"/, "Next keeps the status filter");
    assert.doesNotMatch(p1.html, /href="\/observation\?status=observed&amp;page=/, "a chip link resets to page 1");
  } finally {
    await w.cleanup();
  }
});
