// /uploads knows what a video is FOR -- executed: the real page rendered as
// each role against Postgres.
//
// ── THE DEFECT (F18) ─────────────────────────────────────────────────────────
//
// A teacher whose cycle is waiting for its lesson video gets the dashboard
// to-do "Upload lesson video for 1 cycle", linking to /uploads. There, the
// desktop tray was <UploadProgress contextType="generic" /> and the phone flow
// was <MobileUploadRunner> with no cycle, so it too sent 'generic'. Nothing on
// the page could say which cycle an upload was for, and a generic video is
// visible to its uploader and administrators only: her observer and mentor got
// a 404 for it, and the cycle's Evidence card stayed empty while the upload
// said "ready".
//
// Now /uploads takes ?context=&contextId= (and &quarter= for a mentee's
// quarterly video), runs the reservation's own check on it
// (uploads/context.ts), says what the upload is for, and without one offers the
// user's own open cycles, meetings and quarterly videos to choose from. The
// names of those cycles and pairings are observation and mentorship data, and
// /uploads is outside both gated sections, so they are offered only to someone
// who has unlocked the section -- like every other surface outside them.
//
// The phone flow's own half (it sent a cycle CODE where the server expects the
// id) is executed in upload-target-ui.test.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request, elements, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld, type WorldUser } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

// A programme number with ingest switched on, so /uploads offers the
// WhatsApp route (lib/env.ts whatsappPhoneForUsers).
process.env.GML_WHATSAPP_NUMBER = "+919999999999";
process.env.WHATSAPP_APP_SECRET ??= "test-app-secret";

const PHONE_UA = "Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const asUser = (u: WorldUser): TestUser => ({ id: u.id, role: u.role, name: u.name, email: u.email });

type World = ObservationWorld & { cycle: { id: string; code: string }; meetingId: string };

async function withWorld(body: (w: World) => Promise<void>, opts: { grants?: boolean } = {}) {
  const w = await observationWorld("upctx");
  try {
    const cycle = await w.cycle({ status: "pre_submitted" });
    const meetingId = (
      await w.c.query(
        `INSERT INTO mentor_meetings (pairing_id, scheduled_at, notes) VALUES ($1, now() - interval '2 days', 'held') RETURNING id`,
        [w.pairingId],
      )
    ).rows[0].id as string;
    if (opts.grants !== false) {
      for (const u of [w.teacher, w.mentor, w.observer, w.admin]) {
        await w.grant(u.id, "observation");
        await w.grant(u.id, "mentorship");
      }
    }
    await body({ ...w, cycle, meetingId });
  } finally {
    signIn(null);
    request.headers = {};
    await w.cleanup();
  }
}

async function page(who: WorldUser, sp: Record<string, string> = {}, device: "desktop" | "phone" = "desktop") {
  signIn(asUser(who));
  request.headers = device === "phone" ? { "user-agent": PHONE_UA } : {};
  const { default: UploadsPage } = await import("../../apps/web/src/app/(authenticated)/uploads/page.tsx");
  const r = await outcome(async () => render(withAppRouter(await UploadsPage({ searchParams: Promise.resolve(sp) }))));
  if (r.kind !== "returned") return r;
  return { kind: "returned" as const, html: decodeEntities(String(r.value).replace(/<!-- -->/g, "")) };
}

async function html(who: WorldUser, sp: Record<string, string> = {}, device: "desktop" | "phone" = "desktop") {
  const r = await page(who, sp, device);
  assert.equal(r.kind, "returned", JSON.stringify(r));
  return (r as { html: string }).html;
}

const links = (h: string) => elements(h, "a").map((a) => ({ href: attr(a.open, "href"), text: a.text.trim() }));

/** Every upload control on the page, with the context it would reserve against. */
function uploaders(h: string) {
  return openingTags(h, "div")
    .filter((t) => attr(t, "data-upload-context") !== null)
    .map((t) => ({
      contextType: attr(t, "data-upload-context"),
      contextId: attr(t, "data-upload-context-id"),
      quarter: attr(t, "data-upload-quarter"),
    }));
}

/** The text a WhatsApp link pre-fills. */
const waTexts = (h: string) =>
  links(h)
    .filter((l) => l.href?.startsWith("https://wa.me/"))
    .map((l) => new URL(l.href!).searchParams.get("text"));

test("F18: a teacher on /uploads is asked what the video is for, and offered the cycle waiting for it", { skip }, async () => {
  await withWorld(async (w) => {
    const h = await html(w.teacher);
    const offered = links(h);
    const cycleLink = offered.find((l) => l.href === `/uploads?context=observation_cycle&contextId=${w.cycle.id}`);
    assert.ok(cycleLink, `the teacher's cycle is offered: ${JSON.stringify(offered)}`);
    assert.match(cycleLink!.text, new RegExp(w.cycle.code));
    assert.ok(
      offered.some((l) => l.href === `/uploads?context=mentee_quarterly&contextId=${w.pairingId}&quarter=1`),
      "and her Q1 video for her mentor",
    );
    assert.ok(offered.some((l) => l.href === "/uploads?context=generic"), "and 'something else', knowingly");
    assert.deepEqual(uploaders(h), [], "nothing is uploaded before she says what it is for -- no silent 'generic'");

    // Her mentor's side of the same page: the meeting that has no recording yet.
    const m = links(await html(w.mentor));
    assert.ok(m.some((l) => l.href === `/uploads?context=mentor_meeting&contextId=${w.meetingId}`), JSON.stringify(m));
  });
});

test("F18: a link to a cycle names it and binds the upload to it, on a desktop and on a phone", { skip }, async () => {
  await withWorld(async (w) => {
    const sp = { context: "observation_cycle", contextId: w.cycle.id };
    // The caption the webhook reads is the OBS- tag and the code, however the
    // code is stored (real ones carry the prefix; this world's do not).
    const caption = `OBS-${w.cycle.code.replace(/^OBS-/i, "")}`;
    for (const device of ["desktop", "phone"] as const) {
      const h = await html(w.teacher, sp, device);
      assert.match(h, new RegExp(`data-testid="upload-target"[\\s\\S]*${w.cycle.code}`), `${device}: the page says which cycle`);
      assert.deepEqual(uploaders(h), [{ contextType: "observation_cycle", contextId: w.cycle.id, quarter: "" }], device);
      assert.ok(waTexts(h).length > 0, `${device}: the WhatsApp route is offered`);
      for (const text of waTexts(h)) assert.equal(text, caption, `${device}: WhatsApp pre-fills the exact code the webhook reads`);
    }
  });
});

test("F50: the pairing's mentor lands on a meeting's upload with the meeting's WhatsApp code; an observer gets a 404", { skip }, async () => {
  await withWorld(async (w) => {
    const sp = { context: "mentor_meeting", contextId: w.meetingId };
    const h = await html(w.mentor, sp);
    assert.match(h, /data-testid="upload-target"[\s\S]*[Rr]ecording/);
    assert.deepEqual(uploaders(h), [{ contextType: "mentor_meeting", contextId: w.meetingId, quarter: "" }]);
    assert.deepEqual(waTexts(h), [`MM-${w.meetingId}`], "the MM- code no page used to show");
    assert.deepEqual(await page(w.observer, sp), { kind: "notFound" });
  });
});

test("F50: a mentee's Q1 link binds the upload to the pairing and the quarter", { skip }, async () => {
  await withWorld(async (w) => {
    const h = await html(w.teacher, { context: "mentee_quarterly", contextId: w.pairingId, quarter: "1" });
    assert.match(h, /data-testid="upload-target"[\s\S]*Q1/);
    assert.deepEqual(uploaders(h), [{ contextType: "mentee_quarterly", contextId: w.pairingId, quarter: "1" }]);
    assert.deepEqual(waTexts(h), [`Q1-${w.pairingId}`], "the caption that sends it to the same pairing over WhatsApp");
    const bad = await html(w.teacher, { context: "mentee_quarterly", contextId: w.pairingId, quarter: "4" });
    assert.deepEqual(uploaders(bad), [], "the Q4 video is not open in Q1");
    assert.match(bad, /role="alert"[^>]*>[^<]*Q4/);
  });
});

test("F18: cycles and pairings are offered only once their section is unlocked", { skip }, async () => {
  await withWorld(
    async (w) => {
      const h = await html(w.teacher);
      assert.doesNotMatch(h, new RegExp(w.cycle.code), "no cycle code outside the observation gate");
      const hrefs = links(h).map((l) => l.href);
      assert.ok(hrefs.includes(`/gate/observation?next=${encodeURIComponent("/uploads")}`), JSON.stringify(hrefs));
      assert.ok(hrefs.includes(`/gate/mentorship?next=${encodeURIComponent("/uploads")}`), JSON.stringify(hrefs));

      const direct = await html(w.teacher, { context: "observation_cycle", contextId: w.cycle.id });
      assert.doesNotMatch(direct, new RegExp(w.cycle.code));
      assert.deepEqual(uploaders(direct), []);
      const back = `/uploads?context=observation_cycle&contextId=${w.cycle.id}`;
      assert.ok(links(direct).some((l) => l.href === `/gate/observation?next=${encodeURIComponent(back)}`), "unlock, then come straight back");
    },
    { grants: false },
  );
});

test("F18: with nothing open to choose from, the upload is plainly not linked to anything", { skip }, async () => {
  await withWorld(async (w) => {
    const h = await html(w.admin);
    assert.deepEqual(uploaders(h), [{ contextType: "generic", contextId: "", quarter: "" }]);
    assert.match(h, /data-testid="upload-target"[\s\S]*only you and programme administrators/i);
  });
});

// The section's password comes before anything the page says about a target
// in it. The reservation's check ran first, so a user who had not unlocked
// Observation still learned a cycle's state ("This cycle has been signed off")
// and told a 404 from an "unlock" answer.
test("F18: a link into a locked section asks for its password before saying anything about the target", { skip }, async () => {
  await withWorld(
    async (w) => {
      // Her own cycle, signed off (the world's `cycle` is the open one).
      const closed = (
        await w.c.query(
          `INSERT INTO observation_cycles (code, teacher_id, kind, status, topic) VALUES ($1, $2, 'evaluative', 'complete', 'x') RETURNING id`,
          [`${w.T}-CLOSED`, w.teacherId],
        )
      ).rows[0] as { id: string };
      const h = await html(w.teacher, { context: "observation_cycle", contextId: closed.id });
      assert.doesNotMatch(h, /signed off/i, "the cycle's state is observation data");
      const back = `/uploads?context=observation_cycle&contextId=${closed.id}`;
      assert.ok(links(h).some((l) => l.href === `/gate/observation?next=${encodeURIComponent(back)}`), "unlock first");

      // A cycle she may not see reads the same as one she may, until she unlocks.
      const foreign = await w.c.query(`INSERT INTO teachers (school_id, full_name) VALUES ($1, 'Someone else') RETURNING id`, [w.schoolId]);
      const foreignCycle = (
        await w.c.query(
          `INSERT INTO observation_cycles (code, teacher_id, kind, status, topic) VALUES ($1, $2, 'evaluative', 'nominated', 'x') RETURNING id`,
          [`${w.T}-FOREIGN`, foreign.rows[0].id],
        )
      ).rows[0].id as string;
      try {
        const r = await page(w.teacher, { context: "observation_cycle", contextId: foreignCycle });
        assert.equal(r.kind, "returned", "not a 404 that says the id exists and is someone else's");
        assert.match((r as { html: string }).html, /Unlock Observation/);
      } finally {
        await w.c.query(`DELETE FROM observation_cycles WHERE id = $1`, [foreignCycle]);
        await w.c.query(`DELETE FROM teachers WHERE id = $1`, [foreign.rows[0].id]);
      }

      // The same for a meeting.
      const m = await html(w.teacher, { context: "mentor_meeting", contextId: w.meetingId });
      assert.match(m, /Unlock Mentorship/);
    },
    { grants: false },
  );
});

// The upload check accepts a late Q1 video in any quarter ("a baseline sent
// late is still the baseline"), and the pairing page always offers it; the
// chooser offered no quarterly slot at all in Q2 and Q3.
test("F50: the chooser offers a mentee her Q1 video through Q3, and her Q4 video from Q4", { skip }, async () => {
  await withWorld(async (w) => {
    const slot = (q: number) => `/uploads?context=mentee_quarterly&contextId=${w.pairingId}&quarter=${q}`;
    for (const quarter of [2, 3]) {
      await w.c.query(`UPDATE mentor_pairings SET current_quarter = $2 WHERE id = $1`, [w.pairingId, quarter]);
      const offered = links(await html(w.teacher)).map((l) => l.href);
      assert.ok(offered.includes(slot(1)), `Q${quarter}: the Q1 video is still offered: ${JSON.stringify(offered)}`);
      assert.ok(!offered.includes(slot(4)), `Q${quarter}: not the Q4 video yet`);
    }
    await w.c.query(`UPDATE mentor_pairings SET current_quarter = 4 WHERE id = $1`, [w.pairingId]);
    const inQ4 = links(await html(w.teacher)).map((l) => l.href);
    assert.ok(inQ4.includes(slot(4)), "the Q4 video in the last quarter");
  });
});
