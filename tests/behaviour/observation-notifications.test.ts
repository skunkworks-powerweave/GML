// The observation journey tells people when something is theirs to do.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The only code that ever wrote a notification was the helpdesk route.
// Nominating a cycle told neither the teacher nor the assigned observer, and
// signing one off told nobody -- while /admin/system-settings offered "Cycle
// assigned" and "Cycle complete" toggles and /inbox had icons and links ready
// for both kinds. Separately, the teacher dashboard's to-do list covered
// 'nominated' (pre-form) and 'pre_submitted' (video) and stopped there: a
// cycle waiting on her post-form at 'observed' prompted her for nothing.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real nomination and sign-off actions and the real dashboard, through
// ./_server-actions.ts, against a committed programme.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb } from "./_server-actions.js";
import { decodeEntities, render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

async function inbox(w: ObservationWorld, entityId: string) {
  return (
    await w.c.query(
      `SELECT user_id, kind, entity_type, subject, body FROM notifications WHERE entity_id = $1 ORDER BY kind, user_id`,
      [entityId],
    )
  ).rows as { user_id: string; kind: string; entity_type: string; subject: string; body: string | null }[];
}

// The bell and /inbox are outside the Observation section, so a notification
// may not carry what that section's password guards (lib/gated-reads.ts): the
// cycle's code, its teacher, its kind, its date. The entity link takes the
// reader to the cycle, through the gate.
function assertNothingGated(rows: { subject: string; body: string | null }[], gated: Record<string, RegExp>) {
  assert.ok(rows.length > 0, "something was written");
  for (const r of rows) {
    const text = `${r.subject}\n${r.body ?? ""}`;
    for (const [what, re] of Object.entries(gated)) {
      assert.doesNotMatch(text, re, `the notification names the cycle's ${what}: ${JSON.stringify(text)}`);
    }
  }
}

test("nominating a cycle notifies its teacher, its observer and her mentor -- not the nominator", { skip }, async () => {
  const w = await observationWorld("notifynom");
  try {
    const { nominateCycleAction } = await import("../../apps/web/src/app/(authenticated)/observation/new/actions.ts");
    await w.grant(w.admin.id);
    signIn(w.admin);
    // A year no other suite mints codes in, and nowhere near the demo prefix.
    const r = await outcome(() =>
      nominateCycleAction(
        form({ teacherId: w.teacherId, observerId: w.observer.id, kind: "developmental", scheduledAt: "2099-03-02T10:00", topic: "Fractions" }),
      ),
    );
    assert.equal(r.kind, "redirect");
    const cycleId = (r as { location: string }).location.split("/").pop()!;
    assert.match(cycleId, /^[0-9a-f-]{36}$/, `nominated: ${JSON.stringify(r)}`);

    const rows = await inbox(w, cycleId);
    assert.deepEqual(
      rows.map((n) => [n.kind, n.user_id, n.entity_type]).sort(),
      [
        ["cycle.assigned", w.mentor.id, "observation_cycle"],
        ["cycle.assigned", w.observer.id, "observation_cycle"],
        ["cycle.assigned", w.teacher.id, "observation_cycle"],
      ].sort(),
    );
    const code = (await w.c.query(`SELECT code FROM observation_cycles WHERE id = $1`, [cycleId])).rows[0].code as string;
    assertNothingGated(rows, {
      code: new RegExp(code),
      teacher: /Teacher Row/,
      kind: /developmental/i,
      date: /2099|March/,
    });

    // As /inbox shows it to a party with no grant for the section.
    signIn(w.teacher);
    const { default: InboxPage } = await import("../../apps/web/src/app/(authenticated)/inbox/page.tsx");
    const inboxText = (await render(withAppRouter(await InboxPage({ searchParams: Promise.resolve({}) })))).replace(/<[^>]*>/g, " ");
    assert.match(inboxText, /observation cycle/i, "the teacher is still told");
    assert.doesNotMatch(inboxText, new RegExp(`${code}|Teacher Row|developmental`, "i"));
  } finally {
    await w.cleanup();
  }
});

test("signing a cycle off notifies every other party that it is complete", { skip }, async () => {
  const w = await observationWorld("notifydone");
  try {
    const { signOffCycleAction } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");
    const cyc = await w.cycle({ status: "post_submitted" });
    await w.grant(w.mentor.id);
    signIn(w.mentor);
    const r = await outcome(() => signOffCycleAction(form({ cycleId: cyc.id })));
    assert.deepEqual(r, { kind: "redirect", location: `/observation/${cyc.id}` });
    assert.deepEqual(
      (await inbox(w, cyc.id)).map((n) => [n.kind, n.user_id]).sort(),
      [
        ["cycle.complete", w.observer.id],
        ["cycle.complete", w.teacher.id],
      ].sort(),
      "the teacher and the observer are told; the mentor who signed is not told about his own act",
    );
    assertNothingGated(await inbox(w, cyc.id), { code: new RegExp(cyc.code), teacher: /Teacher Row/ });

    // W3-03: the rows above were written and then HIDDEN -- cycle.complete was
    // not in the default notifications_enabled, which /inbox and the bell
    // filter on. Under the database's own settings, the teacher must see it.
    const [row] = (
      await w.c.query(`SELECT subject FROM notifications WHERE entity_id = $1 AND user_id = $2`, [cyc.id, w.teacher.id])
    ).rows as { subject: string }[];
    const { default: InboxPage } = await import("../../apps/web/src/app/(authenticated)/inbox/page.tsx");
    signIn(w.teacher);
    const page = await outcome(() => InboxPage({ searchParams: Promise.resolve({}) }));
    assert.equal(page.kind, "returned", "the inbox renders for the teacher");
    const html = decodeEntities(await render((page as { value: unknown }).value));
    assert.ok(html.includes(row!.subject), `the teacher's inbox shows the sign-off notice "${row!.subject}"`);
  } finally {
    await w.cleanup();
  }
});

test("a teacher whose cycle is waiting on her post-form is told so on her dashboard", { skip }, async () => {
  const w = await observationWorld("notifypost");
  try {
    await w.cycle({ status: "observed" });
    // The dashboard's observation to-dos follow the section gate.
    await w.grant(w.teacher.id);
    signIn(w.teacher);
    const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
    const text = (await render(withAppRouter(await DashboardPage()))).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    assert.match(text, /Submit post-form for 1 cycle/);
  } finally {
    await w.cleanup();
  }
});
