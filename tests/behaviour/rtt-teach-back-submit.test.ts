// A teacher can send a teach-back, and it reaches the people who review it --
// executed through the real RTT subject page, /uploads, its server actions and
// the review surfaces, against Postgres.
//
// ── THE DEFECT (FR-02) ───────────────────────────────────────────────────────
//
// The review side of RTT's teach-back loop was built: the /rtt/teach-back
// queue, the mentor dashboard's "Pending video reviews" card and its to-do, and
// the sidebar badge. All of them read video_submissions rows with
// context_type 'teach_back', and nothing a teacher could reach wrote one. The
// /uploads chooser offered cycles, quarterly videos and "something else"; the
// "Attach to…" control on a generic video left teach-backs out; no RTT page
// linked an upload; and the WhatsApp TB-<id> caption named an id namespace
// ("the teach_backs surface") that does not exist, so a teacher had no id to
// send. The queue, the card and the badge stayed empty unless someone typed
// /uploads?context=teach_back by hand -- and that stored a teach-back linked to
// nothing, or to any uuid at all.
//
// A teach-back is now FOR an RTT subject: its context id is the subject's id,
// checked like every other context (a subject the uploader is shown). The
// subject page offers the upload, /uploads offers one per subject she is
// shown and can attach a generic video to one, and TB-<subject id> is the
// WhatsApp caption for the same place.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request, decodeEntities, elements, openingTags, attr, mount, hostElements, textOf } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

// beginUploadAction refuses to reserve anything without the two public
// Supabase values; any value will do, nothing here reaches Storage.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://storage.test";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "publishable-test-key";
// A programme number with ingest switched on, so /uploads offers the
// WhatsApp route and its caption (lib/env.ts whatsappPhoneForUsers).
process.env.GML_WHATSAPP_NUMBER = "+919999999999";
process.env.WHATSAPP_APP_SECRET ??= "test-app-secret";

type World = RttWorld & {
  /** A generic video of `by`'s own, stored, as /uploads lists it. */
  video: (by: TestUser, o?: { contextType?: string; contextId?: string | null }) => Promise<string>;
};

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await rttWorld("tbsub");
  const people = () => [w.teacher.id, w.mentor.id, w.observer.id, w.admin.id];
  let n = 0;
  try {
    const video: World["video"] = async (by, o = {}) => {
      const fileId = (
        await w.c.query(
          `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id, original_filename)
           VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2, 'teach.mp4') RETURNING id`,
          [`test/${w.T}/${++n}.mp4`, by.id],
        )
      ).rows[0].id as string;
      return (
        await w.c.query(
          `INSERT INTO video_submissions (file_id, source, status, context_type, context_id, submitted_by_user_id)
           VALUES ($1, 'direct', 'queued', $2, $3, $4) RETURNING id`,
          [fileId, o.contextType ?? "generic", o.contextId ?? null, by.id],
        )
      ).rows[0].id as string;
    };
    await body({ ...w, video });
  } finally {
    signIn(null);
    request.headers = {};
    const subs = (await w.c.query(`SELECT id FROM video_submissions WHERE submitted_by_user_id = ANY($1::uuid[])`, [people()])).rows;
    for (const s of subs) await w.c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${s.id}`]);
    await w.c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = ANY($1::uuid[])`, [people()]);
    await w.c.query(`DELETE FROM files WHERE owner_user_id = ANY($1::uuid[])`, [people()]);
    await w.cleanup();
  }
}

const links = (h: string) => elements(h, "a").map((a) => ({ href: attr(a.open, "href") ?? "", text: a.text.trim() }));

/** The teach-back upload links on a page, as { contextId } of each. */
function teachBackLinks(h: string) {
  return links(h)
    .filter((l) => l.href.startsWith("/uploads?"))
    .map((l) => ({ ...l, q: new URLSearchParams(l.href.slice("/uploads?".length)) }))
    .filter((l) => l.q.get("context") === "teach_back")
    .map((l) => ({ href: l.href, text: l.text, contextId: l.q.get("contextId") }));
}

async function subjectPage(who: TestUser, id: string) {
  signIn(who);
  const { default: RttSubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
  const r = await outcome(async () =>
    render(withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }))),
  );
  assert.equal(r.kind, "returned", JSON.stringify(r));
  return decodeEntities(String((r as { value: unknown }).value).replace(/<!-- -->/g, ""));
}

async function uploadsPage(who: TestUser, sp: Record<string, string> = {}) {
  signIn(who);
  const { default: UploadsPage } = await import("../../apps/web/src/app/(authenticated)/uploads/page.tsx");
  const r = await outcome(async () => render(withAppRouter(await UploadsPage({ searchParams: Promise.resolve(sp) }))));
  assert.equal(r.kind, "returned", JSON.stringify(r));
  return decodeEntities(String((r as { value: unknown }).value).replace(/<!-- -->/g, ""));
}

/** Every upload control on /uploads, with the context it would reserve against. */
function uploaders(h: string) {
  return openingTags(h, "div")
    .filter((t) => attr(t, "data-upload-context") !== null)
    .map((t) => ({ contextType: attr(t, "data-upload-context"), contextId: attr(t, "data-upload-context-id") }));
}

let seq = 0;
async function begin(who: TestUser, input: { contextType: string; contextId?: string | null }) {
  signIn(who);
  const { beginUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
  seq += 1;
  return outcome(() =>
    beginUploadAction({ filename: `teach-${seq}.mp4`, sizeBytes: 2000 + seq, contentType: "video/mp4", ...input }),
  );
}

function reserved(r: Awaited<ReturnType<typeof begin>>): string {
  assert.equal(r.kind, "returned", `expected a reservation, got ${JSON.stringify(r)}`);
  const v = (r as { value: { ok: boolean; submissionId?: string; error?: string } }).value;
  assert.equal(v.ok, true, `refused: ${v.error}`);
  return v.submissionId!;
}

test("FR-02: the subject page offers its teacher a teach-back upload, and the video reaches her mentor's to-do and the review queue", { skip }, async () => {
  await withWorld(async (w) => {
    const subject = await w.subject({ name: `Fractions ${w.T}`, zoneId: w.zoneId });

    // 1. Where she is asked for one: the subject she is learning.
    const offered = teachBackLinks(await subjectPage(w.teacher, subject));
    assert.equal(offered.length, 1, `one teach-back upload on the subject page: ${JSON.stringify(offered)}`);
    assert.equal(offered[0]!.contextId, subject, "bound to this subject");

    // 2. The link names what the upload is for, binds the tray to it, and
    //    gives the WhatsApp caption for the same place.
    const h = await uploadsPage(w.teacher, Object.fromEntries(new URLSearchParams(offered[0]!.href.split("?")[1])));
    assert.match(h, new RegExp(`data-testid="upload-target"[\\s\\S]*Teach-back video for Fractions ${w.T}`));
    assert.deepEqual(uploaders(h), [{ contextType: "teach_back", contextId: subject }]);
    const waTexts = links(h)
      .filter((l) => l.href.startsWith("https://wa.me/"))
      .map((l) => new URL(l.href).searchParams.get("text"));
    assert.deepEqual(waTexts, [`TB-${subject}`], "and TB-<subject> is the caption that sends it there by WhatsApp");

    // 3. The tray reserves against exactly that target.
    const id = reserved(await begin(w.teacher, { contextType: "teach_back", contextId: subject }));
    const row = (await w.c.query(`SELECT context_type, context_id FROM video_submissions WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { context_type: "teach_back", context_id: subject });

    // 4. Once it plays, it is owed a review: her mentor's to-do and card, and
    //    the queue's review pane.
    await w.c.query(
      `UPDATE video_submissions SET status = 'ready', hls_master_key = 'hls/test/index.m3u8', verified_at = now() WHERE id = $1`,
      [id],
    );
    signIn(w.mentor);
    const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
    const dash = decodeEntities((await render(withAppRouter(await DashboardPage()))).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
    assert.match(dash, /Review pending teach-back video/, "the mentor's to-do");
    assert.match(dash, /Pending video reviews 1\b/, "and the card counts it");

    const { default: TeachBackQueuePage } = await import("../../apps/web/src/app/(authenticated)/rtt/teach-back/page.tsx");
    const queue = decodeEntities(
      await render(withAppRouter(await TeachBackQueuePage({ searchParams: Promise.resolve({ status: "review_pending", id }) }))),
    );
    assert.ok(
      openingTags(queue, "form").some((f) => attr(f, "action") === `/api/teach-back/${id}/review`),
      "the queue opens it with its Mark reviewed form",
    );
    assert.match(queue, new RegExp(`Fractions ${w.T}`), "and says which subject it teaches back");

    // 5. And she sees on the subject page that it arrived, and where it stands.
    const after = await subjectPage(w.teacher, subject);
    const card = after.slice(after.indexOf('id="teach-back"'));
    assert.ok(links(card).some((l) => l.href === `/videos/${id}`), "her teach-back is listed, and opens");
    assert.match(card, /Awaiting review/);
    assert.equal(teachBackLinks(card)[0]?.text, "Upload another teach-back →");
  });
});

test("FR-02: a teach-back is the teacher's: the subject page offers staff no upload", { skip }, async () => {
  await withWorld(async (w) => {
    const subject = await w.subject({ zoneId: w.zoneId });
    for (const staff of [w.mentor, w.observer, w.admin]) {
      assert.deepEqual(teachBackLinks(await subjectPage(staff, subject)), [], staff.role);
    }
  });
});

test("FR-02: /uploads offers a teacher a teach-back for each subject she is shown, and only those", { skip }, async () => {
  await withWorld(async (w) => {
    const mine = await w.subject({ name: `Mine ${w.T}`, zoneId: w.zoneId });
    const elsewhere = await w.subject({ name: `Elsewhere ${w.T}`, zoneId: w.zoneYId });
    const retired = await w.subject({ name: `Retired ${w.T}`, zoneId: w.zoneId, active: false });

    const offered = teachBackLinks(await uploadsPage(w.teacher)).map((l) => l.contextId);
    assert.ok(offered.includes(mine), `her subject is offered: ${JSON.stringify(offered)}`);
    assert.ok(!offered.includes(elsewhere), "not a subject taught in another district");
    assert.ok(!offered.includes(retired), "not a retired subject");

    // The chooser is the teacher's: staff are not offered teach-backs.
    assert.deepEqual(teachBackLinks(await uploadsPage(w.mentor)), [], "a mentor reviews teach-backs; he does not send them");
  });
});

test("FR-02: a teacher's generic video can be attached to a teach-back for her subject", { skip }, async () => {
  await withWorld(async (w) => {
    const mine = await w.subject({ zoneId: w.zoneId });
    const id = await w.video(w.teacher);
    const h = await uploadsPage(w.teacher, { context: "generic" });
    const forms = elements(h, "form").filter((f) => f.inner.includes(`value="${id}"`));
    assert.equal(forms.length, 1, "an attach control on the generic row");
    const target = `teach_back|${mine}|`;
    const values = openingTags(forms[0]!.inner, "option").map((o) => attr(o, "value"));
    assert.ok(values.includes(target), `the teach-back is offered: ${JSON.stringify(values)}`);

    signIn(w.teacher);
    const { attachUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    const r = await outcome(() => attachUploadAction(form({ submissionId: id, target })));
    assert.deepEqual(r, { kind: "redirect", location: "/uploads?attach=done" });
    const row = (await w.c.query(`SELECT context_type, context_id FROM video_submissions WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { context_type: "teach_back", context_id: mine });
  });
});

test("FR-02: a teach-back names a subject its uploader is shown; anything else is refused before a row is reserved", { skip }, async () => {
  await withWorld(async (w) => {
    const mine = await w.subject({ zoneId: w.zoneId });
    const elsewhere = await w.subject({ zoneId: w.zoneYId });
    const retired = await w.subject({ zoneId: w.zoneId, active: false });
    const count = async () =>
      Number((await w.c.query(`SELECT count(*) FROM video_submissions WHERE submitted_by_user_id = $1`, [w.teacher.id])).rows[0].count);

    const none = await begin(w.teacher, { contextType: "teach_back" });
    assert.equal(none.kind, "returned");
    const v = (none as { value: { ok: boolean; error?: string } }).value;
    assert.equal(v.ok, false, "a teach-back linked to nothing is not stored");
    assert.match(v.error ?? "", /subject/i, "and she is told to choose the subject");

    for (const [label, contextId] of [
      ["an id that is no subject", randomUUID()],
      ["a subject taught in another district", elsewhere],
      ["a retired subject", retired],
    ] as const) {
      assert.deepEqual(await begin(w.teacher, { contextType: "teach_back", contextId }), { kind: "notFound" }, label);
    }
    assert.equal(await count(), 0, "nothing was reserved");

    reserved(await begin(w.teacher, { contextType: "teach_back", contextId: mine }));
    assert.equal(await count(), 1);

    // A crafted attach target is held to the same rule.
    const generic = await w.video(w.teacher);
    signIn(w.teacher);
    const { attachUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    const r = await outcome(() => attachUploadAction(form({ submissionId: generic, target: `teach_back|${elsewhere}|` })));
    assert.deepEqual(r, { kind: "notFound" });
    const row = (await w.c.query(`SELECT context_type FROM video_submissions WHERE id = $1`, [generic])).rows[0];
    assert.equal(row.context_type, "generic");
  });
});

// The /videos dialog's WhatsApp help listed "TB-<uuid> -- attaches to a
// teach-back session": there is no such session, and nothing gave a teacher
// the id. It now says what the code names and where she gets it.
test("FR-02: the /videos upload dialog says what a TB- code names and where a teacher finds it", async () => {
  const { UploadModal } = await import("../../apps/web/src/components/video/UploadModal.tsx");
  const m = mount(UploadModal as (p: unknown) => unknown, { whatsappPhone: "+919999999999", videoDefaultQuality: "480p" });
  const trigger = hostElements(m.rerender()).find((el) => el.props["data-testid"] === "upload-trigger")!;
  (trigger.props.onClick as () => void)();
  const dialog = textOf(hostElements(m.rerender()).find((el) => el.props["data-testid"] === "upload-modal") ?? null);
  assert.match(dialog, /Send via WhatsApp/, "the dialog is open");
  assert.doesNotMatch(dialog, /teach-back session/, "a teach-back is for a subject, not a session");
  assert.match(dialog, /TB-\S+ — a teach-back for an RTT subject/);
  assert.match(dialog, /subject's page/, "and the subject's page is where its code comes from");
});
