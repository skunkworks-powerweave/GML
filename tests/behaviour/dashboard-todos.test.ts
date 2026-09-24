// The dashboard's "Things waiting on you" list, rendered for real.
//
// Each to-do is a promise that the person reading it can act on it. The REAL
// dashboard page is rendered through ./_server-actions.ts for users of a small
// committed programme (./_observation-world.ts); only auth() is stubbed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

async function dashboard(user: TestUser): Promise<{ todos: string; stats: string; all: string }> {
  signIn(user);
  const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
  const html = await render(withAppRouter(await DashboardPage()));
  const flat = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const all = flat(html);
  // The to-do card is the one whose header reads "Things waiting on you" (or
  // "Your training queue" for a teacher); it ends where the next card begins.
  const m = all.match(/(Things waiting on you\.|Your training queue \+ observation prep\.)(.*?)(Confidentiality|confidentiality)/i);
  return { todos: m ? m[2]! : "", stats: all.split(/Things waiting on you|Your training queue/)[0] ?? "", all };
}

// ── F22: an observer is not asked to do what only a mentor may do ────────────
//
// getObserverTodos turned the observer's post_submitted cycles into "Sign off
// N completed cycle(s) ->". Sign-off is mentor/admin only (signOffCycleAction's
// requireRole, and the cycle page shows the observer no such control), so the
// observer followed the link to find nothing to press -- on a cycle that is not
// "completed" either. The mentor's own to-do for the same cycle is correct.

test("an observer's to-do list never asks them to sign off a cycle", { skip }, async () => {
  const w = await observationWorld("dashobs");
  try {
    const cyc = await w.cycle({ status: "post_submitted" });
    const obs = await dashboard(w.observer);
    assert.doesNotMatch(obs.todos, /sign off/i, `observer to-dos: ${obs.todos}`);
    assert.doesNotMatch(obs.todos, /completed cycle/i, "a post_submitted cycle is not complete");

    const mentor = await dashboard(w.mentor);
    assert.ok(mentor.todos.includes(`Sign off cycle ${cyc.code}`), `mentor to-dos: ${mentor.todos}`);
  } finally {
    await w.cleanup();
  }
});
