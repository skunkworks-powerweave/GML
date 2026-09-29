// A teacher's teach-back goes through the approvals queue: sent for review
// when her upload is recorded, approved or sent back with written feedback by
// her mentor, an observer or a programme admin, and the decision and the
// feedback shown to her -- executed through the real upload action, the real
// review route, the real queue and subject pages and lib/approvals, against
// Postgres.
//
// ── THE GAP ──────────────────────────────────────────────────────────────────
//
// Review was one button, "Mark reviewed", that set reviewed_at and told the
// teacher nothing: no decision, no feedback, no message. Any mentor could
// review any teacher's teach-back, and the approvals handler for teach-backs
// was a placeholder that refused everything. The design
// (docs/superpowers/specs/2026-09-28-teaching-records-design.md): Approve or
// Request changes, with written feedback the teacher sees.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request, decodeEntities, openingTags, attr, elements, SRC_DIR } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const approvalsLib = () => import("../../apps/web/src/lib/approvals/index.ts");
const appDb = async () => (await import("@gml/db")).db as never;

const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

type World = RttWorld & {
  subjectId: string;
  /** A teach-back of `by`'s for the world's subject. */
  clip: (by: TestUser, o?: { status?: "queued" | "ready"; contextType?: string }) => Promise<string>;
  /** Another teacher, with her own mentor (not the world's mentor). */
  other: { teacher: TestUser; teacherId: string; mentor: TestUser };
};

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await rttWorld("tbappr");
  const extra: { pairingId?: string; mentorRowId?: string } = {};
  const people: string[] = [];
  try {
    const subjectId = await w.subject({ name: `Fractions ${w.T}`, zoneId: w.zoneId });
    const otherTeacher = await w.addTeacher("Other");
    const otherMentor = await w.user("OtherMentor", "mentor");
    extra.mentorRowId = (
      await w.c.query(`INSERT INTO mentors (user_id, name) VALUES ($1, $2) RETURNING id`, [otherMentor.id, `Other mentor ${w.T}`])
    ).rows[0].id;
    extra.pairingId = (
      await w.c.query(`INSERT INTO mentor_pairings (mentor_id, teacher_id, status) VALUES ($1, $2, 'active') RETURNING id`, [
        extra.mentorRowId,
        otherTeacher.teacherId,
      ])
    ).rows[0].id;
    people.push(w.teacher.id, otherTeacher.user.id, w.mentor.id, otherMentor.id, w.admin.id, w.observer.id);
    let n = 0;
    const clip: World["clip"] = async (by, o = {}) => {
      const status = o.status ?? "ready";
      const fileId = (
        await w.c.query(
          `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id, original_filename)
           VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2, 'teach.mp4') RETURNING id`,
          [`test/${w.T}/${++n}.mp4`, by.id],
        )
      ).rows[0].id as string;
      return (
        await w.c.query(
          `INSERT INTO video_submissions (file_id, source, status, context_type, context_id, submitted_by_user_id, hls_master_key, verified_at)
           VALUES ($1, 'direct', $2::video_status, $3, $4, $5,
                   CASE WHEN $2 = 'ready' THEN 'hls/test/index.m3u8' END, CASE WHEN $2 = 'ready' THEN now() END)
           RETURNING id`,
          [fileId, status, o.contextType ?? "teach_back", o.contextType === "generic" ? null : subjectId, by.id],
        )
      ).rows[0].id as string;
    };
    await body({
      ...w,
      subjectId,
      clip,
      other: { teacher: otherTeacher.user, teacherId: otherTeacher.teacherId, mentor: otherMentor },
    });
  } finally {
    signIn(null);
    request.locale = "en";
    const subs = (await w.c.query(`SELECT id FROM video_submissions WHERE submitted_by_user_id = ANY($1::uuid[])`, [people])).rows.map(
      (r) => r.id as string,
    );
    await w.c.query(`DELETE FROM approvals WHERE item_type = 'teach_back' AND item_id = ANY($1::uuid[])`, [subs]);
    await w.c.query(`DELETE FROM jobs WHERE dedupe_key = ANY($1::text[])`, [subs.map((s) => `submission:${s}`)]);
    await w.c.query(`DELETE FROM video_submissions WHERE id = ANY($1::uuid[])`, [subs]);
    await w.c.query(`DELETE FROM files WHERE owner_user_id = ANY($1::uuid[])`, [people]);
    await w.c.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [people]);
    if (extra.pairingId) await w.c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [extra.pairingId]);
    if (extra.mentorRowId) await w.c.query(`DELETE FROM mentors WHERE id = $1`, [extra.mentorRowId]);
    await w.cleanup();
  }
}

/** The upload's completion, as the tray sends it (the bytes are already confirmed). */
async function complete(who: TestUser, submissionId: string) {
  signIn(who);
  const { completeUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
  return completeUploadAction(submissionId);
}

async function post(who: TestUser, id: string, fields: Record<string, string>, accept = "application/json") {
  signIn(who);
  const { POST } = await import("../../apps/web/src/app/api/teach-back/[id]/review/route.ts");
  const res = await POST(
    new Request(`http://x/api/teach-back/${id}/review`, {
      method: "POST",
      headers: { accept, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
    { params: Promise.resolve({ id }) },
  );
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  return { status: res.status, body, location: res.headers.get("location") };
}

async function requests(w: World, videoId: string) {
  return (
    await w.c.query<{ id: string; status: string; comment: string | null; submitted_by_user_id: string | null; decided_by_user_id: string | null }>(
      `SELECT id, status, comment, submitted_by_user_id, decided_by_user_id FROM approvals
        WHERE item_type = 'teach_back' AND item_id = $1 ORDER BY submitted_at`,
      [videoId],
    )
  ).rows;
}

async function video(w: World, id: string) {
  return (
    await w.c.query<{ reviewed_at: Date | null; reviewed_by_user_id: string | null; status: string }>(
      `SELECT reviewed_at, reviewed_by_user_id, status FROM video_submissions WHERE id = $1`,
      [id],
    )
  ).rows[0]!;
}

/**
 * `userId`'s approval messages about THIS world's teach-backs. Programme admins
 * are told of everything anyone submits, and other test files submit too.
 */
async function inbox(w: World, userId: string) {
  return (
    await w.c.query<{ subject: string; body: string | null; entity_type: string; entity_id: string }>(
      `SELECT subject, body, entity_type, entity_id FROM notifications
        WHERE user_id = $1 AND kind = 'approval' AND subject LIKE $2 ORDER BY created_at`,
      [userId, `%${w.T}%`],
    )
  ).rows;
}

/**
 * The audit rows for `action` on `entityId`, once they have landed: the route
 * writes its row without waiting for it (`void recordAudit`, spec 097).
 */
async function auditOf(w: World, action: string, entityId: string) {
  type Row = { user_id: string | null; metadata: Record<string, unknown> };
  let rows: Row[] = [];
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    if (i) await new Promise((r) => setTimeout(r, 100));
    rows = (await w.c.query<Row>(`SELECT user_id, metadata FROM audit_log WHERE action = $1 AND entity_id = $2`, [action, entityId])).rows;
  }
  return rows;
}

async function subjectPage(w: World, who: TestUser = w.teacher) {
  signIn(who);
  const { default: Page } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
  const html = await render(withAppRouter(await Page({ params: Promise.resolve({ id: w.subjectId }), searchParams: Promise.resolve({}) })));
  return html.slice(html.indexOf('id="teach-back"'));
}

async function queuePage(who: TestUser, sp: Record<string, string>) {
  signIn(who);
  const { default: Page } = await import("../../apps/web/src/app/(authenticated)/rtt/teach-back/page.tsx");
  return render(withAppRouter(await Page({ searchParams: Promise.resolve(sp) })));
}

const reviewForm = (html: string, id: string) => openingTags(html, "form").some((f) => attr(f, "action") === `/api/teach-back/${id}/review`);

// ── submitting ───────────────────────────────────────────────────────────────

test("a teacher's recorded teach-back upload goes for review; her mentor and the programme admins are told", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.clip(w.teacher, { status: "queued" });
    assert.deepEqual(await complete(w.teacher, id), { ok: true });
    const [req] = await requests(w, id);
    assert.equal(req?.status, "pending", "a pending review request");
    assert.equal(req?.submitted_by_user_id, w.teacher.id);

    for (const who of [w.mentor, w.admin]) {
      const told = await inbox(w, who.id);
      assert.equal(told.length, 1, `${who.role} is told`);
      assert.match(told[0]!.subject, new RegExp(`Teach-back waiting for approval: Fractions ${w.T}`));
      assert.equal(told[0]!.entity_type, "approval");
    }
    assert.equal((await inbox(w, w.other.mentor.id)).length, 0, "not another teacher's mentor");
    assert.equal((await inbox(w, w.observer.id)).length, 0, "observers review from the queue; they are not each told");

    // The browser retries a confirmation on a flaky link: no second request.
    assert.deepEqual(await complete(w.teacher, id), { ok: true });
    assert.equal((await requests(w, id)).length, 1);

    // Not yet decidable: nobody reviews a clip that does not play yet, so it
    // waits outside everyone's queue, as it does outside "Pending review".
    const lib = await approvalsLib();
    const queueOf = async (who: TestUser) => lib.listApprovals(await appDb(), { id: who.id, role: who.role });
    for (const who of [w.admin, w.mentor]) {
      assert.ok(!(await queueOf(who)).some((q) => q.itemId === id), `${who.role}: not while it transcodes`);
    }

    // Once it plays, the approvals queue has it, described: the subject, the
    // teacher, the video.
    await w.c.query(
      `UPDATE video_submissions SET status = 'ready', hls_master_key = 'hls/test/index.m3u8', verified_at = now() WHERE id = $1`,
      [id],
    );
    const entry = (await queueOf(w.admin)).find((q) => q.itemId === id);
    assert.ok(entry, "in the programme admin's queue");
    assert.match(entry!.summary!.title, new RegExp(`^Fractions ${w.T} · \\d{4}-\\d{2}-\\d{2}$`));
    assert.equal(entry!.summary!.subtitle, `Teacher Row ${w.T}`);
    assert.equal(entry!.summary!.href, `/videos/${id}`);
    assert.ok((await queueOf(w.mentor)).some((q) => q.itemId === id), "and in her own mentor's");
  });
});

test("only the video's own teacher sends it; another upload, another teacher's video and a decided one are not sent", { skip }, async () => {
  await withWorld(async (w) => {
    const lib = await approvalsLib();
    const db = await appDb();
    const id = await w.clip(w.teacher);
    for (const who of [w.other.teacher, w.mentor, w.admin]) {
      assert.deepEqual(
        await lib.submitForApproval(db, { itemType: "teach_back", itemId: id, actor: { id: who.id, role: who.role } }),
        { ok: false, error: "not_allowed" },
        who.role,
      );
    }
    // Someone else completing it (an admin finishing her upload) sends nothing.
    assert.deepEqual(await complete(w.admin, id), { ok: true });
    assert.equal((await requests(w, id)).length, 0);

    // A generic upload is not a teach-back...
    const generic = await w.clip(w.teacher, { status: "queued", contextType: "generic" });
    assert.deepEqual(await complete(w.teacher, generic), { ok: true });
    assert.equal((await requests(w, generic)).length, 0);
    // ...until she attaches it to one, which sends it.
    signIn(w.teacher);
    const { attachUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    assert.deepEqual(await outcome(() => attachUploadAction(form({ submissionId: generic, target: `teach_back|${w.subjectId}|` }))), {
      kind: "redirect",
      location: "/uploads?attach=done",
    });
    assert.equal((await requests(w, generic))[0]?.status, "pending", "attached to a teach-back: sent for review");

    // Once decided, it is locked: not sent again.
    assert.deepEqual(await complete(w.teacher, id), { ok: true });
    assert.equal((await post(w.mentor, id, { decision: "approved" })).status, 200);
    assert.deepEqual(
      await lib.submitForApproval(db, { itemType: "teach_back", itemId: id, actor: { id: w.teacher.id, role: "teacher" } }),
      { ok: false, error: "not_allowed" },
      "an approved teach-back is not resubmitted",
    );
  });
});

// ── deciding ─────────────────────────────────────────────────────────────────

test("her mentor approves: the video is reviewed, the teacher is told, and her page shows the decision and the feedback", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.clip(w.teacher);
    await complete(w.teacher, id);

    // The queue offers her own mentor the decision, with a feedback box.
    const pane = await queuePage(w.mentor, { id });
    assert.ok(reviewForm(pane, id), "Approve / Request changes, for her own mentor");
    assert.ok(openingTags(pane, "textarea").some((t) => attr(t, "name") === "feedback"));
    const buttons = elements(pane, "button").map((b) => `${attr(b.open, "value")}:${text(b.inner).trim()}`);
    assert.ok(buttons.includes("approved:Approve") && buttons.includes("changes_requested:Request changes"), JSON.stringify(buttons));

    const r = await post(w.mentor, id, { decision: "approved", feedback: "Clear modelling of the task." }, "text/html");
    assert.equal(r.status, 303);
    assert.match(r.location ?? "", new RegExp(`/rtt/teach-back\\?reviewed=${id}`));

    const [req] = await requests(w, id);
    assert.equal(req?.status, "approved");
    assert.equal(req?.comment, "Clear modelling of the task.");
    assert.equal(req?.decided_by_user_id, w.mentor.id);
    const v = await video(w, id);
    assert.ok(v.reviewed_at instanceof Date, "reviewed: it leaves Pending review");
    assert.equal(v.reviewed_by_user_id, w.mentor.id);
    assert.equal(v.status, "ready", "and still plays");

    const told = await inbox(w, w.teacher.id);
    assert.equal(told.length, 1);
    assert.match(told[0]!.subject, new RegExp(`Teach-back approved: Fractions ${w.T}`));
    assert.equal(told[0]!.body, "Clear modelling of the task.");
    assert.deepEqual([told[0]!.entity_type, told[0]!.entity_id], ["teach_back", id]);

    // The audit rows: the route's and the queue's.
    const reviewed = (await auditOf(w, "teach_back.reviewed", id))[0];
    assert.deepEqual(reviewed?.metadata, { approvalId: req!.id, decision: "approved", created: false });
    assert.equal(reviewed?.user_id, w.mentor.id);
    assert.ok((await auditOf(w, "approval.decided", id)).some((a) => a.user_id === w.mentor.id));
    const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
    const line = doc.split("\n").find((l) => l.startsWith("| `teach_back.reviewed` |"))!;
    const documented = [...line.split("|").slice(1, -1)[2]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]).sort();
    assert.deepEqual(documented, Object.keys(reviewed!.metadata).sort(), "documented as written");

    // Her subject page: the decision and the words.
    const card = text(await subjectPage(w));
    assert.match(card, /Approved/);
    assert.match(card, /Clear modelling of the task\./);

    // The pane now shows what was decided, and offers no second decision.
    const decided = await queuePage(w.mentor, { id });
    assert.ok(!reviewForm(decided, id));
    assert.match(text(decided), new RegExp(`Approved by Mentor ${w.T}`));
    assert.match(text(decided), /Clear modelling of the task\./);
    assert.deepEqual((await post(w.admin, id, { decision: "approved" })).body, { error: "already_reviewed" });
  });
});

// The design: a teach-back is approved or sent back for changes, never
// rejected. /rtt/teach-back offered only those two, but /approvals offered
// Reject for every kind of item and decideApproval took it.
test("a teach-back cannot be rejected, on /approvals or through decideApproval", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.clip(w.teacher);
    await complete(w.teacher, id);
    const [req] = await requests(w, id);
    assert.equal(req?.status, "pending");

    const lib = await approvalsLib();
    assert.deepEqual(
      await lib.decideApproval(await appDb(), { approvalId: req!.id, decision: "rejected", comment: "No", actor: { id: w.mentor.id, role: "mentor" } }),
      { ok: false, error: "decision_not_allowed" },
    );
    assert.equal((await requests(w, id))[0]?.status, "pending", "nothing was decided");
    assert.equal((await video(w, id)).reviewed_at, null, "and the clip is still waiting");

    signIn(w.mentor);
    const { default: RequestPage } = await import("../../apps/web/src/app/(authenticated)/approvals/[id]/page.tsx");
    const html = await render(withAppRouter(await RequestPage({ params: Promise.resolve({ id: req!.id }) })));
    const values = elements(html, "button").map((b) => attr(b.open, "value"));
    assert.deepEqual(values.filter((v) => v === "approved" || v === "changes_requested" || v === "rejected"), ["approved", "changes_requested"]);
  });
});

test("requesting changes needs feedback, and the teacher reads it", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.clip(w.teacher);
    await complete(w.teacher, id);

    const bare = await post(w.observer, id, { decision: "changes_requested", feedback: "   " });
    assert.deepEqual([bare.status, bare.body], [422, { error: "feedback_required" }]);
    assert.equal((await requests(w, id))[0]?.status, "pending", "nothing decided");
    assert.equal((await video(w, id)).reviewed_at, null);
    // A browser post goes back to the pane, which says what is missing.
    const back = await post(w.observer, id, { decision: "changes_requested" }, "text/html");
    assert.equal(back.status, 303);
    assert.match(back.location ?? "", new RegExp(`/rtt/teach-back\\?id=${id}&error=feedback_required`));
    assert.match(text(await queuePage(w.observer, { id, error: "feedback_required" })), /Write the feedback the teacher needs/);
    // And a decision the review does not offer is refused.
    assert.deepEqual((await post(w.observer, id, { decision: "rejected", feedback: "No" })).body, { error: "invalid_decision" });
    assert.deepEqual((await post(w.observer, id, {})).body, { error: "invalid_decision" });

    const r = await post(w.observer, id, { decision: "changes_requested", feedback: "Show the pupils' work at the end." });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    assert.equal((await requests(w, id))[0]?.status, "changes_requested");
    assert.match((await inbox(w, w.teacher.id))[0]!.subject, /Teach-back needs changes/);

    const card = await subjectPage(w);
    assert.match(card, /class="chip chip-rust">Changes requested</);
    assert.match(text(card), /Show the pupils' work at the end\./);
  });
});

test("another teacher's mentor cannot decide her teach-back; neither can she, nor a mentor with no mentees", { skip }, async () => {
  await withWorld(async (w) => {
    const lib = await approvalsLib();
    const db = await appDb();
    const id = await w.clip(w.teacher);
    await complete(w.teacher, id);
    const [req] = await requests(w, id);

    const refused = await post(w.other.mentor, id, { decision: "approved" });
    assert.deepEqual([refused.status, refused.body], [403, { error: "forbidden" }]);
    assert.deepEqual(
      await lib.decideApproval(db, { approvalId: req!.id, decision: "approved", actor: { id: w.other.mentor.id, role: "mentor" } }),
      { ok: false, error: "not_allowed" },
      "the queue itself refuses, whatever page it came from",
    );
    const unpaired = await w.user("Lone", "mentor");
    assert.deepEqual((await post(unpaired, id, { decision: "approved" })).body, { error: "forbidden" });
    assert.deepEqual((await post(w.teacher, id, { decision: "approved" })).body, { error: "forbidden" }, "the teacher does not decide her own");
    assert.equal((await requests(w, id))[0]?.status, "pending");
    assert.equal((await video(w, id)).reviewed_at, null);

    // The queue lists it to the other mentor (programme-wide, as the badge
    // counts) but offers her no decision; the approvals queue leaves it out.
    const pane = await queuePage(w.other.mentor, { id });
    assert.ok(!reviewForm(pane, id));
    assert.match(text(pane), /Only this teacher's own mentor, an observer or a programme admin can review this teach-back/);
    const theirs = (await lib.listApprovals(db, { id: w.other.mentor.id, role: "mentor" })).map((q) => q.itemId);
    assert.ok(!theirs.includes(id));
    const hers = (await lib.listApprovals(db, { id: w.mentor.id, role: "mentor" })).map((q) => q.itemId);
    assert.ok(hers.includes(id), "her own mentor's queue has it");
  });
});

test("a clip that does not play yet cannot be decided", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.clip(w.teacher, { status: "queued" });
    await complete(w.teacher, id);
    assert.deepEqual((await post(w.mentor, id, { decision: "approved" })).body, { error: "not_playable" });
    assert.equal((await requests(w, id))[0]?.status, "pending");
  });
});

// ── a teach-back with no request ─────────────────────────────────────────────

test("a teach-back with no request (WhatsApp, or from before) gets one created and decided in one step", { skip }, async () => {
  await withWorld(async (w) => {
    const legacy = await w.clip(w.teacher);
    assert.equal((await requests(w, legacy)).length, 0, "precondition: nothing sent it");
    const r = await post(w.admin, legacy, { decision: "changes_requested", feedback: "Speak more slowly." });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    const reqs = await requests(w, legacy);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]!.status, "changes_requested");
    assert.equal(reqs[0]!.submitted_by_user_id, w.teacher.id, "on the teacher's behalf, so she is the one told");
    assert.match((await inbox(w, w.teacher.id))[0]!.subject, /Teach-back needs changes/);
    assert.equal((await auditOf(w, "teach_back.reviewed", legacy))[0]?.metadata.created, true);

    // One reviewed under the old button stays reviewed: not reopened, no request made.
    const old = await w.clip(w.teacher);
    await w.c.query(`UPDATE video_submissions SET reviewed_at = now(), reviewed_by_user_id = $2 WHERE id = $1`, [old, w.mentor.id]);
    const again = await post(w.mentor, old, { decision: "approved" });
    assert.deepEqual([again.status, again.body], [409, { error: "already_reviewed" }]);
    assert.equal((await requests(w, old)).length, 0);
    assert.match(text(await subjectPage(w)), /Reviewed/);
  });
});

// ── in Bhoti ─────────────────────────────────────────────────────────────────

test("the decision and the review form are in Bhoti", { skip }, async () => {
  await withWorld(async (w) => {
    type Bundle = Record<string, Record<string, string>>;
    const bundle = (locale: string): Bundle => JSON.parse(readFileSync(join(SRC_DIR, "i18n", "locales", locale, "rtt.json"), "utf8"));
    const [bo, en] = [bundle("bo"), bundle("en")];

    const pending = await w.clip(w.teacher);
    await complete(w.teacher, pending);
    request.locale = "bo";
    const pane = text(await queuePage(w.mentor, { id: pending }));
    for (const key of ["approve", "requestChanges", "feedbackLabel"]) {
      assert.ok(pane.includes(bo.teachBack![key]!), `teachBack.${key} in Bhoti`);
      assert.ok(!pane.includes(en.teachBack![key]!), `teachBack.${key}: no English`);
    }

    request.locale = "en";
    await post(w.mentor, pending, { decision: "changes_requested", feedback: "ཡང་བསྐྱར་ཕབ་རོགས།" });
    request.locale = "bo";
    const card = text(await subjectPage(w));
    assert.ok(card.includes(bo.subject!.teachBackChanges!), "the decision, in Bhoti");
    assert.ok(!card.includes(en.subject!.teachBackChanges!));
    assert.ok(card.includes("ཡང་བསྐྱར་ཕབ་རོགས།"), "and the feedback as written");
  });
});

test("the review pane, with its feedback box and two buttons, fits a phone", { skip }, async () => {
  const { phoneLayoutIssues } = await import("./_phone-layout.js");
  await withWorld(async (w) => {
    const id = await w.clip(w.teacher);
    await complete(w.teacher, id);
    assert.deepEqual(await phoneLayoutIssues(await queuePage(w.mentor, { id, error: "feedback_required" })), [], "the open form");
    await post(w.mentor, id, { decision: "changes_requested", feedback: "Slower, please." });
    assert.deepEqual(await phoneLayoutIssues(await queuePage(w.mentor, { id, reviewed: id })), [], "the decision");
    assert.deepEqual(await phoneLayoutIssues(await subjectPage(w)), [], "her teach-back card");
  });
});
