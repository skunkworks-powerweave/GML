// The observation, video, repository and dashboard pages lay out at PHONE
// width -- executed on their real markup.
//
// ── THE DEFECT (F11) ─────────────────────────────────────────────────────────
//
// The phone shell renders the same page JSX as the desktop shell, and that JSX
// set its columns as inline styles: the cycle page's Forms/Evidence pair was
// gridTemplateColumns "1fr 1fr", the player "1.6fr 1fr", the library cards
// "repeat(3, 1fr)", the repository stats "repeat(5, 1fr)". An inline style
// applies at every width and no stylesheet can override it, so at 360 px the
// cycle page was 546 px wide, /observation 770 px (its eight-column table had
// nowhere to scroll, and its filter chips and the cycle stepper could not
// wrap), and the video metadata sat outside its card where nobody could reach
// it. Chrome widened the layout viewport to the content, and the fixed bottom
// tab bar -- the only navigation on a phone -- was placed off screen.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Each REAL page is rendered as a phone user (gml-device=mobile) against
// Postgres, and ./_phone-layout.ts resolves every element's layout at 360 px
// from its inline style, globals.css and the app's own Tailwind build. The
// first tests below check that resolver against markup whose answer is known,
// so a green page test means the rules ran, not that they found nothing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request } from "./_ui.js";
import { Client } from "pg";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { phoneLayoutIssues, templateAt, PHONE_WIDTH } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)";

async function asPhone(user: TestUser, page: () => Promise<unknown>): Promise<string> {
  signIn(user);
  request.cookies = { "gml-device": "mobile" };
  try {
    return await render(withAppRouter(await page()));
  } finally {
    request.cookies = {};
  }
}

function noIssues(issues: string[], where: string) {
  assert.deepEqual(issues, [], `${where} at ${PHONE_WIDTH}px:\n  ${issues.join("\n  ")}`);
}

// ── the resolver, on markup whose answer is known ────────────────────────────

test("the resolver flags the shapes that overflowed, and passes their phone-safe forms", async () => {
  const bad = {
    inlineTwoColumns: `<section style="display:grid;grid-template-columns:1fr 1fr"><div></div><div></div></section>`,
    inlineRepeat: `<div style="display:grid;grid-template-columns:repeat(3, 1fr)"></div>`,
    // The value column's minimum is its content: a 36-character video id.
    labelValueThatCannotShrink: `<div style="display:grid;grid-template-columns:100px 1fr"><span>Video ID</span><div>uuid</div></div>`,
    evenSplitThatCannotShrink: `<div style="display:grid;grid-template-columns:1fr 1fr"><div></div><div></div></div>`,
    wideAutoFill: `<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr))"></div>`,
    tailwindWithoutBreakpoint: `<div class="grid grid-cols-3"></div>`,
    bareTable: `<div class="card"><table class="t"></table></div>`,
    scrolledTableInAutoTrack: `<div style="display:grid;gap:16px"><div class="card"><div style="overflow-x:auto"><table></table></div></div></div>`,
    scrolledTableInFlexRow: `<div style="display:flex"><div class="card"><div style="overflow-x:auto"><table></table></div></div></div>`,
    chipsThatCannotWrap: `<div style="display:flex;gap:4px"><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></div>`,
    // globals.css makes .stepper a flex row; each step sits in a display:contents span.
    stepper: `<div class="stepper"><span style="display:contents"><div class="step">1</div></span><span style="display:contents"><div class="step">2</div></span><span style="display:contents"><div class="step">3</div></span></div>`,
  };
  for (const [name, html] of Object.entries(bad)) {
    assert.ok((await phoneLayoutIssues(html)).length > 0, `${name} is flagged`);
  }
  const good = {
    collapsesBelowMd: `<section class="grid grid-cols-1 md:grid-cols-[1.6fr_1fr]"><div></div></section>`,
    autoFitThatFits: `<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr))"></div>`,
    autoFillCappedAt100: `<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(min(100%, 280px), 1fr))"></div>`,
    labelValue: `<div style="display:grid;grid-template-columns:100px minmax(0, 1fr)"><span>Video ID</span><div>uuid</div></div>`,
    evenSplitThatShrinks: `<div class="grid grid-cols-2"><div></div><div></div></div>`,
    // The phone detail header: back arrow, a title that clips, a spacer.
    headerWithClippedTitle: `<header style="display:grid;grid-template-columns:44px 1fr 44px"><a href="/x">←</a><h1 style="overflow:hidden">T</h1><div></div></header>`,
    scrolledTableInMinZeroTrack: `<div style="display:grid;grid-template-columns:minmax(0, 1fr)"><div class="card"><div style="overflow-x:auto"><table></table></div></div></div>`,
    scrollBoxIsTheGridItem: `<div style="display:grid"><div class="card" style="overflow-x:auto"><table></table></div></div>`,
    wrappingChips: `<div style="display:flex;gap:4px;flex-wrap:wrap"><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></div>`,
    wrappingStepper: `<div class="stepper flex-wrap"><span style="display:contents"><div class="step">1</div></span><span style="display:contents"><div class="step">2</div></span><span style="display:contents"><div class="step">3</div></span></div>`,
    hiddenOnPhone: `<div style="display:none"><table></table></div>`,
  };
  for (const [name, html] of Object.entries(good)) {
    assert.deepEqual(await phoneLayoutIssues(html), [], `${name} passes`);
  }
  // The breakpoint is real: the same class is two columns on a desktop.
  const html = `<section class="grid grid-cols-1 md:grid-cols-[1.6fr_1fr]"></section>`;
  assert.deepEqual(await templateAt(html, PHONE_WIDTH, (e) => e.tag === "section"), ["repeat(1, minmax(0, 1fr))"]);
  assert.deepEqual(await templateAt(html, 1280, (e) => e.tag === "section"), ["1.6fr 1fr"]);
});

// ── /observation and a cycle ─────────────────────────────────────────────────

test("/observation fits a phone: the table scrolls inside its card, the filter chips wrap", { skip }, async () => {
  const w = await observationWorld("phoneobsl");
  try {
    const cyc = await w.cycle({ status: "nominated" });
    await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);

    const { default: ListPage } = await import(`${APP}/observation/page.tsx`);
    const list = await asPhone(w.teacher, () => ListPage({ searchParams: Promise.resolve({}) }));
    noIssues(await phoneLayoutIssues(list), "/observation");
    // The entry into a cycle is at the row's left edge, not only the '›' in
    // the last column that a phone shows off to the right.
    assert.match(list, new RegExp(`<a[^>]*href="/observation/${cyc.id}"[^>]*>[^<]*${cyc.code}`), "the cycle code links to the cycle");
  } finally {
    await w.cleanup();
  }
});

test("a cycle page fits a phone: Forms and Evidence stack, the stepper wraps; the desktop keeps two columns", { skip }, async () => {
  const w = await observationWorld("phoneobsc");
  try {
    const cyc = await w.cycle({ status: "nominated" });
    await w.grant(w.teacher.id);

    const { default: CyclePage } = await import(`${APP}/observation/[cycleId]/page.tsx`);
    const detail = await asPhone(w.teacher, () =>
      CyclePage({ params: Promise.resolve({ cycleId: cyc.id }), searchParams: Promise.resolve({}) }),
    );
    assert.match(detail, /name="lessonPlanSummary"/, "the teacher's pre-form is on the page");
    noIssues(await phoneLayoutIssues(detail), "/observation/[cycleId]");

    // The desktop layout is unchanged: Forms and Evidence still side by side.
    const desktop = await templateAt(detail, 1280, (e) => e.tag === "section" && /md:grid-cols/.test(e.attrs.class ?? ""));
    assert.ok(desktop.some((t) => columns(t) === 2), `two columns on a desktop: ${desktop.join(" | ")}`);
  } finally {
    await w.cleanup();
  }
});

/** Track count of a resolved template ("minmax(0,1.6fr) minmax(0,1fr)" -> 2). */
function columns(template: string): number {
  return template.split(/\s+(?![^(]*\))/).filter(Boolean).length;
}

// ── /videos and a video ──────────────────────────────────────────────────────

test("/videos and a video page fit a phone: one card per row, the player full width, the metadata inside its card", { skip }, async () => {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("phonevid");
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
    const teacher = { id: userId, role: "teacher", name: `Teacher ${T}` };
    const { default: LibraryPage } = await import(`${APP}/videos/page.tsx`);
    const library = await asPhone(teacher, () => LibraryPage({ searchParams: Promise.resolve({}) }));
    assert.match(library, new RegExp(`href="/videos/${videoId}"`), "the video is in the library");
    noIssues(await phoneLayoutIssues(library), "/videos");

    const { default: PlayerPage } = await import(`${APP}/videos/[id]/page.tsx`);
    const player = await asPhone(teacher, () => PlayerPage({ params: Promise.resolve({ id: videoId }) }));
    assert.match(player, new RegExp(videoId), "the metadata card shows the video id");
    noIssues(await phoneLayoutIssues(player), "/videos/[id]");

    // The desktop keeps the player beside its metadata.
    const desktop = await templateAt(player, 1280, (e) => (e.attrs.class ?? "").split(" ").includes("page-body"));
    assert.equal(desktop.length, 1);
    assert.equal(columns(desktop[0]!), 2, `two columns on a desktop: ${desktop[0]}`);
  } finally {
    await c.query(`DELETE FROM video_submissions WHERE id = $1`, [videoId]);
    await c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.end();
  }
});

// ── /dashboard ───────────────────────────────────────────────────────────────

test("the dashboard fits a phone for a teacher and for an administrator (with the field map)", { skip }, async () => {
  const w = await observationWorld("phonedash");
  try {
    await w.grant(w.teacher.id);
    await w.grant(w.admin.id);
    const { default: DashboardPage } = await import(`${APP}/dashboard/page.tsx`);
    for (const user of [w.teacher, w.admin]) {
      const html = await asPhone(user, () => DashboardPage());
      noIssues(await phoneLayoutIssues(html), `/dashboard as ${user.role}`);
    }
  } finally {
    await w.cleanup();
  }
});
