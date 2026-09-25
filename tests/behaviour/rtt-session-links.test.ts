// RTT session Join/Watch links are web links, on the way in and on the way out.
//
// ── THE DEFECT (F44) ─────────────────────────────────────────────────────────
//
// rtt-readings validated its link as http(s); rtt-sessions took
// link_or_recording as any string up to 2000 characters, and both the subject
// page and the webinar calendar put it straight into an href. A Meet link
// pasted the way Meet and Calendar display it -- "meet.google.com/abc-defg-hij",
// no scheme -- resolved relative to the page, so every teacher's "Join" opened
// an in-app 404 at session time. Anything else (a `javascript:` URL) went into
// the href too.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The admin grid's REAL create action as a programme admin, and the REAL
// subject page and calendar rendering rows already stored before the fix.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, form } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(closeAppDb);

const hrefs = (html: string) => openingTags(html, "a").map((t) => attr(t, "href") ?? "");

test("F44: a session link typed without https:// is stored as https://; a non-web link is refused", { skip }, async () => {
  const w = await rttWorld("f44-write");
  try {
    const s = await w.subject();
    signIn(w.admin);
    const { createRowAction } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
    const create = (sequence: string, link: string) =>
      createRowAction(
        undefined,
        form({ entitySlug: "rtt-sessions", rttSubjectId: s, sequence, title: `Link ${sequence} ${w.T}`, type: "webinar", linkOrRecording: link }),
      );

    assert.deepEqual(await create("1", "meet.google.com/audit-abc"), { ok: true });
    assert.deepEqual(await create("2", "https://meet.google.com/audit-def"), { ok: true });
    for (const [seq, bad] of [["3", "javascript:alert(1)"], ["4", "/rtt/subject/x"], ["5", "not a link"]]) {
      const r = await create(seq, bad);
      assert.equal(r.ok, false, `${bad} is not a link a teacher can join`);
      assert.ok(r.fieldErrors?.linkOrRecording, "and the form says which field");
    }
    // No link at all is still allowed: "No link yet".
    assert.deepEqual(
      await createRowAction(
        undefined,
        form({ entitySlug: "rtt-sessions", rttSubjectId: s, sequence: "6", title: `None ${w.T}`, type: "webinar" }),
      ),
      { ok: true },
    );

    const { rows } = await w.c.query(
      `SELECT sequence, link_or_recording FROM rtt_sessions WHERE rtt_subject_id = $1 ORDER BY sequence`,
      [s],
    );
    assert.deepEqual(
      rows.map((r) => [r.sequence, r.link_or_recording]),
      [
        [1, "https://meet.google.com/audit-abc"],
        [2, "https://meet.google.com/audit-def"],
        [6, null],
      ],
    );
  } finally {
    await w.cleanup();
  }
});

test("F44: a stored link without a scheme renders as https://, and a non-web one renders no link", { skip }, async () => {
  const w = await rttWorld("f44-read");
  try {
    const s = await w.subject();
    const soon = new Date(Date.now() + 2 * 3_600_000);
    // Rows as the grid stored them before it validated.
    await w.session(s, { sequence: 1, title: `Legacy ${w.T}`, scheduledAt: soon, link: "meet.google.com/legacy-xyz" });
    await w.session(s, { sequence: 2, title: `Hostile ${w.T}`, scheduledAt: soon, link: "javascript:alert(1)" });

    signIn(w.teacher);
    const { default: RttSubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
    const page = hrefs(
      await render(withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id: s }), searchParams: Promise.resolve({}) }))),
    );
    const { default: Calendar } = await import("../../apps/web/src/app/(authenticated)/rtt/online/synchronous/page.tsx");
    const cal = hrefs(await render(withAppRouter(await Calendar())));

    for (const [where, list] of [["subject page", page], ["calendar", cal]] as const) {
      assert.ok(list.includes("https://meet.google.com/legacy-xyz"), `${where}: Join opens the meeting`);
      assert.ok(!list.includes("meet.google.com/legacy-xyz"), `${where}: never a relative link into the app`);
      assert.ok(!list.some((h) => /^javascript:/i.test(h)), `${where}: never a script link`);
    }
  } finally {
    await w.cleanup();
  }
});
