// /mentorship pages through every pairing, executed through the real page.
//
// ── F29 (/mentorship) ────────────────────────────────────────────────────────
//
// The list ran one `.orderBy(desc(startedAt)).limit(80)` with no page
// parameter while its status chips counted the whole scoped set, so at launch
// scale (about 500 paired teachers) a programme admin saw "All 95" over 80
// cards and could not reach the rest. The ORDER BY had no tiebreaker either,
// and the seed gives every pairing the same started_at, so even the 80 were
// not a stable window.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const EXTRA = 85;

async function withManyPairings(body: (w: World, all: string[]) => Promise<void>) {
  const w = await buildWorld("paging");
  const [{ school_id }] = await w.q<{ school_id: string }>(`SELECT school_id FROM teachers WHERE id = $1`, [w.teacherAId]);
  const extraTeachers: string[] = [];
  try {
    for (let i = 0; i < EXTRA; i++) {
      const [t] = await w.q<{ id: string }>(`INSERT INTO teachers (school_id, full_name) VALUES ($1, $2) RETURNING id`, [school_id, `Paged ${i} ${w.T}`]);
      extraTeachers.push(t!.id);
    }
    // One started_at for all of them, as the seed writes it: only an id
    // tiebreaker makes the pages a partition.
    await w.q(
      `INSERT INTO mentor_pairings (mentor_id, teacher_id, status, started_at)
       SELECT $1, t, 'active', '2026-09-24 12:17:04+00' FROM unnest($2::uuid[]) AS t`,
      [w.mentorId, extraTeachers],
    );
    const all = (await w.q<{ id: string }>(`SELECT id FROM mentor_pairings WHERE mentor_id = $1`, [w.mentorId])).map((r) => r.id);
    signIn(w.mentor);
    await body(w, all);
  } finally {
    signIn(null);
    await w.q(`DELETE FROM mentor_pairings WHERE teacher_id = ANY($1::uuid[])`, [extraTeachers]);
    await w.q(`DELETE FROM teachers WHERE id = ANY($1::uuid[])`, [extraTeachers]);
    await w.cleanup();
  }
}

async function listPage(sp: Record<string, string>) {
  const { default: MentorshipListPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/page.tsx");
  const r = await outcome(() => MentorshipListPage({ searchParams: Promise.resolve(sp) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value)).replace(/<!-- -->/g, "");
}

const cardIds = (html: string) => [...html.matchAll(/href="\/mentorship\/([0-9a-f-]{36})"/g)].map((m) => m[1]!);

test("every pairing is reachable from the list, once, across its pages", { skip }, async () => {
  await withManyPairings(async (_w, all) => {
    const seen: string[] = [];
    let html = await listPage({});
    for (let page = 1; page <= 5; page++) {
      seen.push(...cardIds(html));
      const next = /href="\/mentorship\?([^"]*page=\d+[^"]*)"[^>]*>\s*Next/.exec(html)?.[1];
      if (!next) break;
      html = await listPage(Object.fromEntries(new URLSearchParams(next)));
    }
    assert.equal(new Set(seen).size, seen.length, "no pairing on two pages");
    assert.deepEqual([...seen].sort(), [...all].sort(), `all ${all.length} pairings, not the first 80`);
    // The 85 share one started_at; only the id tiebreaker fixes their order,
    // and a fixed order is what makes page N the same rows on every request.
    const tied = seen.slice(-EXTRA);
    assert.deepEqual(tied, [...tied].sort().reverse(), "tied pairings are ordered by id, newest-first key");
  });
});

test("the page says which slice of how many it is showing", { skip }, async () => {
  await withManyPairings(async (_w, all) => {
    const html = await listPage({});
    assert.match(html, new RegExp(`Showing 1–\\d+ of ${all.length}`));
  });
});

test("paging keeps the status filter", { skip }, async () => {
  await withManyPairings(async () => {
    const html = await listPage({ status: "active" });
    assert.match(html, /href="\/mentorship\?status=active&amp;page=2"|href="\/mentorship\?status=active&page=2"/);
  });
});
