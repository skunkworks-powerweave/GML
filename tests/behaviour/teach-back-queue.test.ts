// /rtt/teach-back -- the expert-review queue -- rendered for a mentor against
// real rows in Postgres.
//
// ── THE DEFECTS ──────────────────────────────────────────────────────────────
//
// F12. The page selected the 80 NEWEST teach-backs programme-wide and only then
// applied "Pending review" / "Reviewed" and built the tab counts, in memory.
// Reviewed clips never leave that candidate set, so once 80 newer teach-backs
// existed an unreviewed clip older than them vanished from every tab, the
// ?id= preview (looked up inside the same slice) would not open, and the
// "Mark reviewed" form -- the only UI that reviews a clip -- was unreachable.
// Meanwhile the dashboard card and the sidebar badge still counted it. The row
// chips were keyed on video_submissions.status values nothing writes since
// migration 0022 (review_pending / reviewed), so every chip was neutral grey
// and the page's own promise -- saffron pending, lichen reviewed -- was false.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL page, through the app's own @gml/db pool, signed in as a mentor.
// Rows are committed under a unique tag and removed afterwards. Every test that
// writes teach-back rows lives in this one file, so they run in sequence and
// cannot disturb each other's programme-wide counts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, decodeEntities, attr } from "./_ui.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

const skip = needsDatabase();
after(closeAppDb);

type World = {
  c: Client;
  T: string;
  mentor: TestUser;
  teacherUserId: string;
  fileId: string;
  /** Insert one teach-back; returns its id. */
  clip: (o: { status?: string; reviewed?: boolean; createdAgo: string }) => Promise<string>;
  counts: () => Promise<{ all: number; pending: number; reviewed: number }>;
  cleanup: () => Promise<void>;
};

async function world(prefix: string): Promise<World> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag(prefix);
  const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
  const mentorId = await one(
    `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'mentor') RETURNING id`,
    [`${T}-m@example.test`, `Mentor ${T}`],
  );
  const teacherUserId = await one(
    `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`,
    [`${T}-t@example.test`, `Teacher ${T}`],
  );
  const fileId = await one(
    `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id)
     VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2) RETURNING id`,
    [`test/${T}/original.mp4`, teacherUserId],
  );
  return {
    c,
    T,
    mentor: { id: mentorId, role: "mentor", name: `Mentor ${T}` },
    teacherUserId,
    fileId,
    clip: async ({ status = "ready", reviewed = false, createdAgo }) =>
      one(
        // A ready clip has its HLS master and was verified (a table CHECK).
        `INSERT INTO video_submissions
           (file_id, source, status, context_type, submitted_by_user_id, caption_raw, created_at,
            hls_master_key, verified_at, reviewed_at, reviewed_by_user_id)
         VALUES ($1, 'direct', $2::video_status, 'teach_back', $3, $4, now() - $5::interval,
                 CASE WHEN $2 = 'ready' THEN 'hls/test/index.m3u8' END,
                 CASE WHEN $2 = 'ready' THEN now() END,
                 CASE WHEN $6 THEN now() END,
                 CASE WHEN $6 THEN $7::uuid END)
         RETURNING id`,
        [fileId, status, teacherUserId, `${T} clip`, createdAgo, reviewed, mentorId],
      ),
    counts: async () => {
      const r = (
        await c.query(
          `SELECT count(*)::int AS all,
                  count(*) FILTER (WHERE status = 'ready' AND reviewed_at IS NULL)::int AS pending,
                  count(*) FILTER (WHERE reviewed_at IS NOT NULL)::int AS reviewed
             FROM video_submissions WHERE context_type = 'teach_back'`,
        )
      ).rows[0];
      return { all: r.all, pending: r.pending, reviewed: r.reviewed };
    },
    cleanup: async () => {
      await c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [teacherUserId]);
      await c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
      await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[mentorId, teacherUserId]]);
      await c.end();
    },
  };
}

/** 80 ready, REVIEWED teach-backs, all newer than a day ago. */
async function eightyNewerReviewed(w: World): Promise<void> {
  await w.c.query(
    `INSERT INTO video_submissions
       (file_id, source, status, context_type, submitted_by_user_id, caption_raw, created_at,
        hls_master_key, verified_at, reviewed_at, reviewed_by_user_id)
     SELECT $1, 'direct', 'ready', 'teach_back', $2, $3 || ' newer ' || g,
            now() - interval '1 day' + make_interval(secs => g), 'hls/test/index.m3u8', now(), now(), $4
       FROM generate_series(1, 80) g`,
    [w.fileId, w.teacherUserId, w.T, w.mentor.id],
  );
}

type Rendered = {
  html: string;
  text: string;
  /** Ids of the rows in the list, in order. */
  rowIds: string[];
  /** The chip markup of one listed row. */
  chipOf: (id: string) => string | null;
};

async function queue(user: TestUser, sp: Record<string, string>): Promise<Rendered> {
  signIn(user);
  const { default: TeachBackQueuePage } = await import("../../apps/web/src/app/(authenticated)/rtt/teach-back/page.tsx");
  const html = await render(withAppRouter(await TeachBackQueuePage({ searchParams: Promise.resolve(sp) })));
  const rows = [...html.matchAll(/<li>(<a\b[^>]*>)([\s\S]*?)<\/a><\/li>/g)].map((m) => ({
    id: new URLSearchParams((attr(m[1]!, "href") ?? "").replace(/^\?/, "")).get("id") ?? "",
    inner: m[2]!,
  }));
  const text = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
  return {
    html,
    text,
    rowIds: rows.map((r) => r.id),
    chipOf: (id) => {
      const inner = rows.find((r) => r.id === id)?.inner;
      if (inner === undefined) return null;
      const spans = [...inner.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)];
      const last = spans[spans.length - 1];
      return last ? `${last[1]} | ${last[2]}` : null;
    },
  };
}

const reviewForm = (html: string, id: string) => html.includes(`action="/api/teach-back/${id}/review"`);

// ── F12: the queue is not a window onto the 80 newest ────────────────────────

test("an unreviewed clip older than 80 newer reviewed ones is still in 'Pending review', and the counts are the database's", { skip }, async () => {
  const w = await world("tbq");
  try {
    const old = await w.clip({ createdAgo: "3 days" });
    await eightyNewerReviewed(w);
    const db = await w.counts();

    const pending = await queue(w.mentor, { status: "review_pending" });
    assert.ok(pending.rowIds.includes(old), "the overdue clip is exactly the one a reviewer must be able to reach");
    assert.equal(pending.rowIds[0], old, "pending is oldest first: the SLA is on age");
    assert.match(pending.text, new RegExp(`All ${db.all} Pending review ${db.pending} Reviewed ${db.reviewed}`),
      `the tabs count every teach-back, not the newest 80 (database: ${JSON.stringify(db)}; page: ${pending.text.match(/All \d+ Pending review \d+ Reviewed \d+/)?.[0]})`);
  } finally {
    await w.cleanup();
  }
});

test("?id= opens an old pending clip's review form although it is not on the first page", { skip }, async () => {
  const w = await world("tbq");
  try {
    const old = await w.clip({ createdAgo: "3 days" });
    await eightyNewerReviewed(w);

    const all = await queue(w.mentor, { id: old });
    assert.ok(!all.rowIds.includes(old), "precondition: the All tab's first page is the 80 newest");
    assert.ok(reviewForm(all.html, old), "a deep link (dashboard, notification) must open the review pane");

    const inPending = await queue(w.mentor, { status: "review_pending", id: old });
    assert.ok(reviewForm(inPending.html, old));

    // Switching to a tab the clip is not in still clears the selection.
    const inReviewed = await queue(w.mentor, { status: "reviewed", id: old });
    assert.ok(!reviewForm(inReviewed.html, old), "a pending clip is not selectable under 'Reviewed'");
  } finally {
    await w.cleanup();
  }
});

test("every teach-back is reachable from the All tab, a page at a time", { skip }, async () => {
  const w = await world("tbq");
  try {
    const old = await w.clip({ createdAgo: "3 days" });
    await eightyNewerReviewed(w);
    const db = await w.counts();

    const seen: string[] = [];
    let page = 1;
    let current = await queue(w.mentor, {});
    assert.match(current.text, new RegExp(`Showing 1–${current.rowIds.length} of ${db.all}`), "the list says how much it shows");
    seen.push(...current.rowIds);
    while (/href="\?page=\d+"[^>]*>\s*Next/.test(current.html)) {
      page += 1;
      assert.ok(page < 50, "paging terminates");
      current = await queue(w.mentor, { page: String(page) });
      seen.push(...current.rowIds);
    }
    assert.ok(seen.includes(old), "the oldest clip is on a later page");
    assert.equal(seen.length, db.all, `every teach-back appears once across the pages (saw ${seen.length})`);
    assert.equal(new Set(seen).size, db.all, "no teach-back appears twice");
  } finally {
    await w.cleanup();
  }
});

test("the row chip shows review state: pending saffron, reviewed lichen, still-processing neutral", { skip }, async () => {
  const w = await world("tbq");
  try {
    const pending = await w.clip({ createdAgo: "2 hours" });
    const reviewed = await w.clip({ createdAgo: "3 hours", reviewed: true });
    const processing = await w.clip({ createdAgo: "1 hour", status: "transcoding" });
    const failed = await w.clip({ createdAgo: "4 hours", status: "failed" });

    const page = await queue(w.mentor, {});
    const chip = (id: string) => page.chipOf(id) ?? assert.fail(`row ${id} is not listed`);
    assert.match(chip(pending), /var\(--saffron-soft\).*\| pending review$/);
    assert.match(chip(reviewed), /var\(--lichen-soft\).*\| reviewed$/);
    assert.match(chip(processing), /var\(--paper-2\).*\| transcoding$/);
    assert.match(chip(failed), /var\(--paper-2\).*\| failed$/);
  } finally {
    await w.cleanup();
  }
});
