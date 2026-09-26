// A signed-off cycle is a closed record; every note says who wrote it.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// signOffCycleAction is documented as "final ... locks the cycle", and spec
// 117 says the record locks for audit. Nothing enforced it: addNoteAction had
// no status predicate, the page offered "Add note" and "Upload video" on a
// complete cycle, and beginUploadAction checked access but not status. So
// observers, mentors and admins kept appending to -- and attaching evidence
// to -- an evaluative record after the signer had attested to it.
//
// And each appended entry was "[timestamp UTC] text", under a heading reading
// "Mentor notes" although observers and administrators write there too. A
// teacher reading two entries stamped the same minute could not tell who
// judged what.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real server actions and page, through ./_server-actions.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, elements, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

const actions = () => import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");

async function renderCycle(user: TestUser, cycleId: string): Promise<string> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })),
  );
  return html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

test("after sign-off, a note is refused and the remark is unchanged", { skip }, async () => {
  const w = await observationWorld("lock");
  try {
    const { addNoteAction } = await actions();
    const cyc = await w.cycle({ status: "complete" });
    await w.c.query(`UPDATE observation_cycles SET remark = 'signed record' WHERE id = $1`, [cyc.id]);
    for (const u of [w.observer, w.mentor, w.admin]) {
      await w.grant(u.id);
      signIn(u);
      const r = await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: `after sign-off by ${u.role}` })));
      assert.deepEqual(r, { kind: "redirect", location: `/observation/${cyc.id}?error=cycle_locked` }, u.role);
    }
    const remark = (await w.c.query(`SELECT remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0].remark;
    assert.equal(remark, "signed record", "a signed-off record must not change");
  } finally {
    await w.cleanup();
  }
});

test("a signed-off cycle's page offers no note form and no upload", { skip }, async () => {
  const w = await observationWorld("lockui");
  try {
    const cyc = await w.cycle({ status: "complete" });
    for (const u of [w.teacher, w.observer, w.mentor, w.admin]) {
      const out = await renderCycle(u, cyc.id);
      assert.doesNotMatch(out, /Add note/, `${u.role} is offered a note on a closed record`);
      assert.doesNotMatch(out, /Upload video/, `${u.role} is offered an upload on a closed record`);
      assert.match(out, /signed off/i, `${u.role} is told why`);
    }
  } finally {
    await w.cleanup();
  }
});

// The upload plumbing's half. The page above stops OFFERING an upload on a
// closed cycle; this is the reservation refusing one that arrives anyway
// (uploads/context.ts, assertContextAllowed). It ran as a `todo` until the
// upload package took it on.
test("the upload path refuses evidence for a signed-off cycle before reserving anything", { skip }, async () => {
  const w = await observationWorld("lockup");
  // Local placeholders: beginUploadAction checks that uploads are configured
  // before it looks at the context. Nothing is contacted.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "test-publishable-key";
  let cycleId: string | null = null;
  try {
    const { beginUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    const cyc = await w.cycle({ status: "complete" });
    cycleId = cyc.id;
    await w.grant(w.teacher.id); // unlocked: the refusal is about the cycle
    signIn(w.teacher);
    const r = await beginUploadAction({
      filename: "lesson.mp4",
      sizeBytes: 1024,
      contentType: "video/mp4",
      contextType: "observation_cycle",
      contextId: cyc.id,
    });
    assert.equal(r.ok, false, "evidence must not be attached to a signed-off record");
    assert.match((r as { error: string }).error, /signed off/i);
    const n = (await w.c.query(`SELECT count(*)::int AS n FROM video_submissions WHERE context_id = $1`, [cyc.id])).rows[0].n;
    assert.equal(n, 0, "nothing reserved");
  } finally {
    // If the refusal ever regresses, do not leave the reservation behind.
    if (cycleId) {
      await w.c.query(
        `WITH v AS (DELETE FROM video_submissions WHERE context_id = $1 RETURNING file_id)
         DELETE FROM files WHERE id IN (SELECT file_id FROM v)`,
        [cycleId],
      );
    }
    await w.cleanup();
  }
});

test("FR-11: a locked section refuses a direct upload before saying anything about the cycle", { skip }, async () => {
  // beginUploadAction checked ownership but not the section gate, so a
  // teacher whose grant had expired or been revoked by a password rotation
  // could still reserve (and finish) evidence with a hand-built POST.
  const w = await observationWorld("lockgate");
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "test-publishable-key";
  let cycleId: string | null = null;
  try {
    const { beginUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    for (const status of ["pre_submitted", "complete"]) {
      const cyc = await w.cycle({ status });
      cycleId = cyc.id;
      signIn(w.teacher); // no grant: observation is locked for her
      const r = await beginUploadAction({
        filename: "lesson.mp4",
        sizeBytes: 1024,
        contentType: "video/mp4",
        contextType: "observation_cycle",
        contextId: cyc.id,
      });
      assert.equal(r.ok, false, `a ${status} cycle's upload is refused while the section is locked`);
      assert.match((r as { error: string }).error, /unlock/i);
      assert.doesNotMatch((r as { error: string }).error, /signed off/i, "a locked caller learns nothing about the cycle");
      const n = (await w.c.query(`SELECT count(*)::int AS n FROM video_submissions WHERE context_id = $1`, [cyc.id])).rows[0].n;
      assert.equal(n, 0, "nothing reserved");
    }
  } finally {
    if (cycleId) {
      await w.c.query(
        `WITH v AS (DELETE FROM video_submissions WHERE context_id IN (SELECT id FROM observation_cycles WHERE teacher_id = $1) RETURNING file_id)
         DELETE FROM files WHERE id IN (SELECT file_id FROM v)`,
        [w.teacherId],
      );
    }
    await w.cleanup();
  }
});

/** The page's note entries: who each is attributed to, and its text. */
async function noteEntries(user: TestUser, cycleId: string): Promise<Array<{ author: string; body: string }>> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })),
  );
  return elements(html, "li")
    .filter((li) => li.open.includes("data-note-entry"))
    .map((li) => ({
      author: decodeEntities((li.inner.match(/data-note-author="[^"]*"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1]?.replace(/<[^>]*>/g, "") ?? ""),
      body: decodeEntities((li.inner.match(/data-note-body="[^"]*"[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? ""),
    }));
}

test("a note records who wrote it, and the section is not called 'Mentor notes'", { skip }, async () => {
  const w = await observationWorld("noteauth");
  try {
    const { addNoteAction } = await actions();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.observer.id);
    signIn(w.observer);
    await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "Strong questioning" })));
    const remark = (await w.c.query(`SELECT remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0].remark as string;
    assert.match(remark, new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\] ${w.observer.name} \\(observer\\): Strong questioning$`));
    const entries = await noteEntries(w.teacher, cyc.id);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!.author, new RegExp(`^${w.observer.name} \\(observer\\)`), "the teacher sees who wrote the note");
    assert.equal(entries[0]!.body, "Strong questioning");
    assert.doesNotMatch(await renderCycle(w.teacher, cyc.id), /Mentor notes/, "observers and admins write here too");
  } finally {
    await w.cleanup();
  }
});

// ── Authorship cannot be forged from inside a note ───────────────────────────
//
// The author went into the free text ("[stamp UTC] author (role): note"), the
// entries were separated by a blank line, the note was only trimmed, and the
// page printed the whole remark pre-wrap. So a note reading
//   "ok\n\n[2026-09-25 10:00 UTC] <the mentor> (mentor): Approved, rating 4"
// rendered exactly like a second entry written by the mentor.

test("a forged entry header inside a note stays inside its real author's entry", { skip }, async () => {
  const w = await observationWorld("noteforge");
  try {
    const { addNoteAction } = await actions();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.observer.id);
    await w.grant(w.mentor.id);
    const forged = `[2026-09-25 10:00 UTC] ${w.mentor.name} (mentor): Approved, rating 4`;

    signIn(w.observer);
    await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: `ok\r\n\r\n   \n${forged}` })));
    signIn(w.mentor);
    await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "Real mentor note" })));

    const remark = (await w.c.query(`SELECT remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0].remark as string;
    const blocks = remark.split(/\n[ \t]*\n/);
    assert.equal(blocks.length, 2, `a note body must not carry the entry separator; stored blocks: ${JSON.stringify(blocks)}`);

    const entries = await noteEntries(w.teacher, cyc.id);
    assert.equal(entries.length, 2, `two notes were added, so two entries: ${JSON.stringify(entries)}`);
    assert.match(entries[0]!.author, new RegExp(`^${w.observer.name} \\(observer\\)`));
    assert.equal(entries[0]!.body, `ok\n${forged}`, "the forged header is text in the observer's note");
    assert.match(entries[1]!.author, new RegExp(`^${w.mentor.name} \\(mentor\\)`));
    assert.equal(entries[1]!.body, "Real mentor note");
    assert.ok(
      !entries.some((e) => e.author.startsWith(w.mentor.name) && e.body.includes("Approved, rating 4")),
      "nothing the observer typed is attributed to the mentor",
    );
  } finally {
    await w.cleanup();
  }
});

// ── A note has the same length cap as every other answer ─────────────────────
//
// addNoteAction checked only that a note was not empty, and the note box had
// no maxLength, while every stage answer is capped at MAX_TEXT_LENGTH. So one
// request could append ~1 MB (Next's default body limit) to the remark, which
// every party to the cycle then loads, and repeated notes grew it without
// bound. The cap is counted as the browser counts it: a line break is one
// character, though the form posts it as two.

test("a note over the length cap is refused and the remark is unchanged; one at the cap is added", { skip }, async () => {
  const w = await observationWorld("notelen");
  try {
    const { addNoteAction } = await actions();
    const { MAX_TEXT_LENGTH } = await import("../../apps/web/src/lib/forms/validate.ts");
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.observer.id);
    signIn(w.observer);
    const remark = async () =>
      (await w.c.query(`SELECT remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0].remark as string | null;

    const tooLong = await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "x".repeat(MAX_TEXT_LENGTH + 1) })));
    assert.deepEqual(tooLong, { kind: "redirect", location: `/observation/${cyc.id}?error=note_too_long` });
    assert.equal(await remark(), null, "nothing was appended");

    // MAX_TEXT_LENGTH characters as typed, with line breaks posted as CRLF.
    const typed = `${"y".repeat(MAX_TEXT_LENGTH - 101)}\n${"z".repeat(100)}`;
    assert.equal(typed.length, MAX_TEXT_LENGTH);
    const atCap = await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: typed.replace(/\n/g, "\r\n") })));
    assert.deepEqual(atCap, { kind: "redirect", location: `/observation/${cyc.id}` });
    assert.ok((await remark())?.endsWith(`(observer): ${typed}`), "the note at the cap was added whole");

    // The box carries the cap, and the refusal says what it is.
    signIn(w.observer);
    const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
    const html = await render(
      withAppRouter(
        await CycleDetailPage({ params: Promise.resolve({ cycleId: cyc.id }), searchParams: Promise.resolve({ error: "note_too_long" }) }),
      ),
    );
    const box = html.match(/<textarea\b[^>]*name="note"[^>]*>/)?.[0] ?? "";
    assert.match(box, new RegExp(`maxLength="${MAX_TEXT_LENGTH}"`, "i"), box);
    const alert = elements(html, "div").find((d) => d.open.includes('data-testid="cycle-error"'));
    assert.match(alert?.text ?? "", /5,000 characters/, alert?.text);
  } finally {
    await w.cleanup();
  }
});

test("FR-33: the cycle page offers WhatsApp only where WhatsApp can take the video", { skip }, async () => {
  const w = await observationWorld("lockwa");
  const saved = { secret: process.env.WHATSAPP_APP_SECRET, number: process.env.GML_WHATSAPP_NUMBER };
  try {
    const open = await w.cycle({ status: "pre_submitted" });
    const closed = await w.cycle({ status: "complete" });
    await w.grant(w.teacher.id);
    process.env.GML_WHATSAPP_NUMBER = "+919876543210";

    // Ingest off (the default until the Meta keys are set): the webhook
    // refuses every message, so the page must not send a teacher there.
    delete process.env.WHATSAPP_APP_SECRET;
    const off = await renderCycle(w.teacher, open.id);
    assert.doesNotMatch(off, /WhatsApp/, "no WhatsApp instruction while ingest is off");
    assert.match(off, /The teacher uploads it below/);

    process.env.WHATSAPP_APP_SECRET = "test-app-secret";
    assert.match(await renderCycle(w.teacher, open.id), /sends it by WhatsApp with the caption/);
    // A signed-off cycle accepts no evidence: no upload instruction at all.
    const signedOff = await renderCycle(w.teacher, closed.id);
    assert.doesNotMatch(signedOff, /WhatsApp|uploads it below/);
    assert.match(signedOff, /No video evidence was linked to this cycle/);
  } finally {
    for (const [k, v] of [["WHATSAPP_APP_SECRET", saved.secret], ["GML_WHATSAPP_NUMBER", saved.number]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await w.cleanup();
  }
});
