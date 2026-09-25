// Signing out leaves no one's unsent observation or form text in the browser.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The sign-out button wiped the QuickFind recents and nothing else. Two draft
// stores were added after it and never hooked in: the cycle page's
// DraftTextarea drafts (sessionStorage "gml:obs-draft:<user>:...", which held
// a rubric or a note verbatim until the tab closed, saved or not), and the
// form runners' device copies (localStorage "gml-form-draft:<user>:...",
// written whenever an autosave failed and surviving the browser closing). Both
// are keyed per user, so the app never shows them to someone else, but on a
// shared school machine the confidential text stayed readable after its
// author had signed out.
//
// A device copy is also a promise ("Your answers are kept on this device"),
// so it is not thrown away unasked: sign-out asks first, and a "no" keeps the
// user signed in with the answers where they were.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real SignOutButton through ./_ui.ts mount(), its real onClick, and the
// real writers of each store, against Storage stand-ins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_ui.js";
import { draftScope, saveDraft } from "../../apps/web/src/lib/observation/drafts.ts";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  keys() { return [...this.m.keys()].sort(); }
}

type Click = { prevented: boolean; preventDefault: () => void };
const click = (): Click => {
  const e = { prevented: false, preventDefault: () => (e.prevented = true) };
  return e;
};

async function withBrowser(
  body: (b: { session: MemoryStorage; local: MemoryStorage; asked: string[]; answer: (yes: boolean) => void }) => Promise<void>,
) {
  const g = globalThis as Record<string, unknown>;
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const asked: string[] = [];
  let yes = true;
  // In a browser globalThis is window; the stores are reached both ways.
  g.window = {
    sessionStorage: session,
    localStorage: local,
    confirm: (msg: string) => (asked.push(msg), yes),
  };
  g.localStorage = local;
  try {
    await body({ session, local, asked, answer: (a) => (yes = a) });
  } finally {
    delete g.window;
    delete g.localStorage;
  }
}

async function signOutClick(): Promise<Click> {
  const { SignOutButton } = await import("../../apps/web/src/components/nav/SignOutButton.tsx");
  const tree = mount(SignOutButton as never, { children: "Sign out" } as never).tree as unknown as {
    props: { onClick: (e: Click) => void };
  };
  const e = click();
  tree.props.onClick(e);
  return e;
}

test("signing out removes every observation draft, whoever typed it and whether or not it was saved", async () => {
  await withBrowser(async ({ session, local, asked }) => {
    saveDraft(session, draftScope("user-a", "cycle-1", "narrativeComments"), "pre_submitted", "Confidential rubric");
    saveDraft(session, draftScope("user-a", "cycle-1", "note"), "2", "A note already saved under an older version");
    saveDraft(session, draftScope("user-b", "cycle-9", "note"), "0", "Someone else's note");
    session.setItem("unrelated", "kept");
    local.setItem("gml.quickfind.recent.user-a", "[]");
    local.setItem("gml-theme", "dark");

    const e = await signOutClick();
    assert.equal(e.prevented, false, "sign-out goes ahead");
    assert.deepEqual(asked, [], "nothing unsaved on the server's side: nothing to ask");
    assert.deepEqual(session.keys(), ["unrelated"], "no observation draft is left in the tab");
    assert.deepEqual(local.keys(), ["gml-theme"], "QuickFind recents go as before; unrelated settings stay");
  });
});

test("unsaved form answers on the device are discarded at sign-out only after asking", async () => {
  const { keepLocalCopy } = await import("../../apps/web/src/components/forms/draft-resilience.ts");
  await withBrowser(async ({ session, local, asked, answer }) => {
    keepLocalCopy("user-a", { templateId: "tpl-1", pairingId: "pair-1" }, { reflection: "Unsent answer" });
    keepLocalCopy("user-b", { templateId: "tpl-2", pairingId: "pair-2" }, { reflection: "Another user's" });
    saveDraft(session, draftScope("user-a", "cycle-1", "note"), "0", "Typed note");
    const before = local.keys();
    assert.equal(before.filter((k) => k.startsWith("gml-form-draft:")).length, 2);

    // "No": still signed in, and every answer is where it was.
    answer(false);
    const kept = await signOutClick();
    assert.equal(asked.length, 1, "the user is asked");
    assert.match(asked[0]!, /not (yet )?(been )?saved|have not reached/i, asked[0]);
    assert.equal(kept.prevented, true, "declining keeps the user signed in");
    assert.deepEqual(local.keys(), before, "nothing was discarded");
    assert.equal(session.length, 1);

    // "Yes": everything goes, then the sign-out proceeds.
    answer(true);
    const gone = await signOutClick();
    assert.equal(gone.prevented, false);
    assert.deepEqual(local.keys().filter((k) => k.startsWith("gml-form-draft:")), [], "no device copy is left");
    assert.equal(session.length, 0, "no observation draft is left");
  });
});

test("storage that throws never blocks signing out", async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    get sessionStorage() { throw new Error("blocked"); },
    get localStorage() { throw new Error("blocked"); },
    confirm: () => false,
  };
  Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    const e = await signOutClick();
    assert.equal(e.prevented, false, "sign-out goes ahead");
  } finally {
    delete g.window;
    delete g.localStorage;
  }
});
