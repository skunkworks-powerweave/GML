// The /rtt hub offers the teach-back queue only to those it admits.
//
// ── THE DEFECT (F45) ─────────────────────────────────────────────────────────
//
// The hub rendered "Teach-back queue ->" for everyone, but /rtt/teach-back lets
// in only super_admin, programme_admin, mentor and observer. Teachers -- the
// main audience of /rtt -- followed it to the access-denied page.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL /rtt for each role, and the REAL queue page's own answer to the same
// user: the link is offered exactly when the page would let them in.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, outcome, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(closeAppDb);

async function offersQueue(user: TestUser): Promise<boolean> {
  signIn(user);
  const { default: RttIndexPage } = await import("../../apps/web/src/app/(authenticated)/rtt/page.tsx");
  const html = await render(withAppRouter(await RttIndexPage({ searchParams: Promise.resolve({}) })));
  return openingTags(html, "a").some((t) => attr(t, "href") === "/rtt/teach-back");
}

async function queueAdmits(user: TestUser): Promise<boolean> {
  signIn(user);
  const { default: TeachBackQueuePage } = await import("../../apps/web/src/app/(authenticated)/rtt/teach-back/page.tsx");
  const r = await outcome(() => TeachBackQueuePage({ searchParams: Promise.resolve({}) }));
  return !(r.kind === "redirect" && r.location === "/forbidden");
}

test("F45: /rtt links the teach-back queue for exactly the roles the queue admits", { skip }, async () => {
  const w = await rttWorld("f45");
  try {
    const superAdmin = await w.user("Super", "super_admin");
    for (const user of [w.teacher, w.observer, w.mentor, w.admin, superAdmin]) {
      const admitted = await queueAdmits(user);
      assert.equal(await offersQueue(user), admitted, `${user.role}: link offered ${admitted ? "" : "only "}when the queue admits`);
    }
    assert.equal(await offersQueue(w.teacher), false, "a teacher is not sent to /forbidden");
  } finally {
    await w.cleanup();
  }
});
