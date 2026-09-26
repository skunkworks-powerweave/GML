// What RTT stands for, on the page named after it (W3-72).
//
// The programme is Refresher Teacher Training: the page metadata, the
// teach-back page, the sign-in page and the help entry say so (the last two
// since F13, pinned in ui-copy-promises.test.ts). The /rtt header still
// expanded it as "Recruit, Train, Transform", copied from the design
// prototype, so a teacher read two different names for her programme a click
// apart.
//
// The REAL /rtt, rendered for a teacher and an administrator of a small
// committed programme (./_rtt-world.ts). Only auth() is stubbed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const text = (html: string) => decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

async function hub(user: TestUser): Promise<string> {
  signIn(user);
  const { default: RttIndexPage } = await import("../../apps/web/src/app/(authenticated)/rtt/page.tsx");
  return text(await render(withAppRouter(await RttIndexPage({ searchParams: Promise.resolve({}) }))));
}

test("W3-72: /rtt names the programme Refresher Teacher Training", { skip }, async () => {
  const w = await rttWorld("w372");
  try {
    for (const user of [w.teacher, w.admin]) {
      const page = await hub(user);
      assert.doesNotMatch(page, /Recruit,? Train/i, `${user.role}: /rtt expands RTT as the prototype did`);
      assert.match(page, /RTT — Refresher Teacher Training/, `${user.role}`);
    }
  } finally {
    await w.cleanup();
  }
});
