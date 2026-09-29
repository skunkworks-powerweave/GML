// /approvals: who sees what in the queue, deciding through the page's own
// action, and the request page with its history.
//
// Executed against the test database with the app's own pool: the real
// pages (rendered), the real decideAction, the real lib/approvals. A teacher's
// session and an account request wait in the queue; the programme admin sees
// both, a mentor and an observer neither, a teacher not the page at all.
// Decisions: approve, request changes (comment required), reject, twice
// (refused), by a teacher (refused), and an account request cannot be sent
// back for changes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { render, request, withAppRouter } from "./_ui.js";
import { phoneLayoutIssues } from "./_phone-layout.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, form, outcome, signIn } from "./_server-actions.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const queuePage = () => import("../../apps/web/src/app/(authenticated)/approvals/page.tsx");
const requestPage = () => import("../../apps/web/src/app/(authenticated)/approvals/[id]/page.tsx");
const actions = () => import("../../apps/web/src/app/(authenticated)/approvals/actions.ts");

type World = {
  f: Fixture;
  t: string;
  teacherUser: string;
  padmin: string;
  mentor: string;
  observer: string;
  sessionId: string;
  sessionApproval: string;
  requestId: string;
  requestApproval: string;
};

/** A school, a teacher with a session waiting for approval, and an account request waiting too. */
async function world(f: Fixture, t: string): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: `S${code}`.slice(0, 16) });
  const klass = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
  const subject = await f.row("subjects", { name: `Sub ${t}`, code: `SB${code}`.slice(0, 16) });
  const teacherUser = await f.user("teacher", "t1");
  const padmin = await f.user("programme_admin", "pa");
  const mentor = await f.user("mentor", "m");
  const observer = await f.user("observer", "o");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: teacherUser });
  const sessionId = await f.row("sessions", {
    school_id: school,
    class_id: klass,
    subject_id: subject,
    teacher_id: teacher,
    scheduled_date: "2026-09-28",
    topic: `Fractions ${t}`,
    approval_status: "pending",
  });
  const requestId = await f.row("account_requests", {
    full_name: `Dolma ${t}`,
    email: `dolma.${t}@example.test`,
    school_id: school,
    requested_role: "teacher",
    message: `Please ${t}`,
  });
  // The rows submitForApproval and the public form write (inserted directly,
  // so no other file's programme admins are notified of this world).
  const sessionApproval = await f.row("approvals", {
    item_type: "session",
    item_id: sessionId,
    submitted_by_user_id: teacherUser,
    note: `Check the attendance ${t}`,
  });
  const requestApproval = await f.row("approvals", { item_type: "account_request", item_id: requestId, note: `Please ${t}` });
  f.defer(`DELETE FROM approvals WHERE item_id = ANY($1::uuid[])`, [[sessionId, requestId]]);
  f.defer(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [[teacherUser, padmin, mentor, observer]]);
  return { f, t, teacherUser, padmin, mentor, observer, sessionId, sessionApproval, requestId, requestApproval };
}

const as = (id: string, role: string) => signIn({ id, role });

test("the queue: a programme admin sees the session and the account request; mentors and observers see neither", { skip }, async () => {
  const lib = await import("../../apps/web/src/lib/approvals/index.ts");
  const { db } = await import("@gml/db");
  await withClient(async (c) => {
    const f = fixture(c, tag("aq"));
    try {
      const w = await world(f, tag("aqw"));
      const ids = (entries: Array<{ id: string }>) => new Set(entries.map((e) => e.id));

      const admin = ids(await lib.listApprovals(db as never, { id: w.padmin, role: "programme_admin" }));
      assert.ok(admin.has(w.sessionApproval), "the programme admin decides sessions");
      assert.ok(admin.has(w.requestApproval), "and account requests");
      for (const [id, role] of [[w.mentor, "mentor"], [w.observer, "observer"], [w.teacherUser, "teacher"]] as const) {
        const theirs = ids(await lib.listApprovals(db as never, { id, role }));
        assert.equal(theirs.has(w.sessionApproval), false, `a ${role} does not decide sessions`);
        assert.equal(theirs.has(w.requestApproval), false, `a ${role} does not decide account requests`);
      }
      // The badge counts what the queue lists.
      assert.ok((await lib.pendingApprovalCount(db as never, { id: w.padmin, role: "programme_admin" })) >= 2);

      // The page, as the programme admin: both entries, the submitter's note,
      // the public form as the account request's sender, and decision forms.
      as(w.padmin, "programme_admin");
      const { default: ApprovalsPage } = await queuePage();
      const html = await render(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
      assert.match(html, new RegExp(`Fractions ${w.t}`));
      assert.match(html, new RegExp(`Check the attendance ${w.t}`), "the submitter's note is shown");
      assert.match(html, new RegExp(`Dolma ${w.t}`));
      assert.match(html, /Sent from the Request an account form/);
      assert.match(html, new RegExp(`href="/approvals/${w.sessionApproval}"`));
      assert.match(html, new RegExp(`href="/teaching/sessions/${w.sessionId}"`), "the record opens on its own page");
      assert.match(html, /value="changes_requested"/, "a session can be sent back");

      // Filtered to account requests: the session is not listed, and the
      // account request offers no "Request changes".
      const onlyAccounts = await render(await ApprovalsPage({ searchParams: Promise.resolve({ type: "account_request" }) }));
      assert.doesNotMatch(onlyAccounts, new RegExp(`Fractions ${w.t}`));
      assert.match(onlyAccounts, new RegExp(`Dolma ${w.t}`));
      const card = onlyAccounts.slice(onlyAccounts.indexOf(`Dolma ${w.t}`));
      assert.doesNotMatch(card.slice(0, card.indexOf("</li>")), /value="changes_requested"/);

      // A mentor's page lists neither; a teacher cannot open it.
      as(w.mentor, "mentor");
      const mentorHtml = await render(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
      assert.doesNotMatch(mentorHtml, new RegExp(`Fractions ${w.t}|Dolma ${w.t}`));
      as(w.teacherUser, "teacher");
      assert.deepEqual(await outcome(() => ApprovalsPage({ searchParams: Promise.resolve({}) })), {
        kind: "redirect",
        location: "/forbidden",
      });
    } finally {
      signIn(null);
      await f.cleanup();
    }
  });
});

test("deciding through the page: comment rules, one decision per request, and nobody but an approver", { skip }, async () => {
  const { decideAction } = await actions();
  await withClient(async (c) => {
    const f = fixture(c, tag("ad"));
    try {
      const w = await world(f, tag("adw"));
      const state = async () =>
        (await c.query(`SELECT approval_status FROM sessions WHERE id = $1`, [w.sessionId])).rows[0].approval_status;
      const decide = (decision: string, comment = "", approvalId = w.sessionApproval) =>
        decideAction(undefined, form({ approvalId, decision, comment }));

      // Nobody signed in, a teacher, a mentor: refused, nothing changes.
      signIn(null);
      assert.match((await decide("approved")).error ?? "", /Sign in again/);
      as(w.teacherUser, "teacher");
      assert.match((await decide("approved")).error ?? "", /cannot decide/);
      as(w.mentor, "mentor");
      assert.match((await decide("approved")).error ?? "", /cannot decide/);
      assert.equal(await state(), "pending");

      as(w.padmin, "programme_admin");
      // Request changes and reject need a comment; the typed comment comes back.
      const noComment = await decide("changes_requested", "   ");
      assert.match(noComment.error ?? "", /Write a comment/);
      assert.equal(await state(), "pending");
      assert.match((await decide("rejected")).error ?? "", /Write a comment/);
      // A malformed decision is refused, not guessed.
      assert.match((await decide("maybe")).error ?? "", /could not be read/);

      const back = await decide("changes_requested", `Add the late arrivals ${w.t}`);
      assert.equal(back.decided, "changes_requested", JSON.stringify(back));
      assert.match(back.ok ?? "", /Sent back/);
      assert.equal(await state(), "changes_requested");
      assert.ok(request.revalidated?.includes("/approvals"), "the queue is refreshed");
      // Once decided, it cannot be decided again.
      assert.match((await decide("approved")).error ?? "", /already been decided/);
      // The teacher is told, with the comment.
      const told = await c.query(`SELECT subject, body FROM notifications WHERE user_id = $1 AND kind = 'approval'`, [w.teacherUser]);
      assert.equal(told.rowCount, 1);
      assert.equal(told.rows[0].body, `Add the late arrivals ${w.t}`);

      // Resubmitted, then approved: the record is locked.
      const again = await f.row("approvals", { item_type: "session", item_id: w.sessionId, submitted_by_user_id: w.teacherUser });
      await c.query(`UPDATE sessions SET approval_status = 'pending' WHERE id = $1`, [w.sessionId]);
      const ok = await decide("approved", "", again);
      assert.equal(ok.decided, "approved", JSON.stringify(ok));
      assert.equal(await state(), "approved");

      // An account request is approved or rejected, never sent back.
      const noChanges = await decide("changes_requested", "Use your school address", w.requestApproval);
      assert.match(noChanges.error ?? "", /nothing to send back/);
      const { rows: [req] } = await c.query(`SELECT status FROM account_requests WHERE id = $1`, [w.requestId]);
      assert.equal(req.status, "pending");

      // The request page: both requests for the session, oldest first, with
      // the decision and comment on the first.
      const { default: RequestPage } = await requestPage();
      const html = await render(await RequestPage({ params: Promise.resolve({ id: again }) }));
      const history = html.slice(html.indexOf('data-testid="approval-history"'));
      assert.ok(history.indexOf("Changes requested") < history.indexOf("Approved"), "oldest first");
      assert.match(history, new RegExp(`Add the late arrivals ${w.t}`));
      assert.match(history, new RegExp(`Check the attendance ${w.t}`), "the first request's note");
      assert.doesNotMatch(html, /name="decision"/, "a decided request offers no decision");
    } finally {
      signIn(null);
      await f.cleanup();
    }
  });
});

test("a request page is 404 to anyone who may not decide it, and the pages speak Hindi", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("ap"));
    try {
      const w = await world(f, tag("apw"));
      const { default: RequestPage } = await requestPage();
      const open = (id: string) => outcome(() => RequestPage({ params: Promise.resolve({ id }) }));

      as(w.mentor, "mentor");
      assert.deepEqual(await open(w.requestApproval), { kind: "notFound" }, "a mentor does not decide account requests");
      assert.deepEqual(await open(w.sessionApproval), { kind: "notFound" }, "nor sessions");
      as(w.teacherUser, "teacher");
      assert.deepEqual(await open(w.sessionApproval), { kind: "redirect", location: "/forbidden" }, "not even her own");
      as(w.padmin, "programme_admin");
      assert.deepEqual(await open("not-a-uuid"), { kind: "notFound" });
      assert.deepEqual(await open(randomUUID()), { kind: "notFound" });

      request.locale = "hi";
      const { default: ApprovalsPage } = await queuePage();
      const queue = await render(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
      assert.match(queue, /स्वीकृतियाँ/, "the heading is Hindi");
      assert.match(queue, /खाता अनुरोध/, "so is the kind");
      assert.match(queue, /शिक्षक/, "and the role asked for");
      assert.match(queue, /स्वीकृत करें/, "and the decision buttons");
      assert.doesNotMatch(queue, />Approve</);

      const page = await render(await RequestPage({ params: Promise.resolve({ id: w.requestApproval }) }));
      assert.match(page, new RegExp(`dolma\\.${w.t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@example\\.test`));
      assert.match(page, /माँगी गई भूमिका/);
      assert.match(page, /खाता अनुरोध फ़ॉर्म/, "sent from the public form");
      assert.doesNotMatch(page, /data-testid="email-has-login"/, "the address has no login yet");
      assert.doesNotMatch(page, /value="changes_requested"/);

      // On a phone: nothing makes the page scroll sideways at 360px, and the
      // request page sits in the phone's detail frame with a way back.
      request.locale = "en";
      request.cookies = { "gml-device": "mobile" };
      const phoneQueue = await render(withAppRouter(await ApprovalsPage({ searchParams: Promise.resolve({}) })));
      assert.deepEqual(await phoneLayoutIssues(phoneQueue), [], "/approvals at phone width");
      const phoneRequest = await render(withAppRouter(await RequestPage({ params: Promise.resolve({ id: w.sessionApproval }) })));
      assert.match(phoneRequest, /data-testid="mobile-detail-back"[^>]*href="\/approvals"|href="\/approvals"[^>]*data-testid="mobile-detail-back"/);
      assert.deepEqual(await phoneLayoutIssues(phoneRequest), [], "/approvals/[id] at phone width");
    } finally {
      request.cookies = {};
      request.locale = "en";
      signIn(null);
      await f.cleanup();
    }
  });
});
