// What someone types into a cycle form survives a submit that does not land.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Three refusals return a user to the cycle with nothing recorded: the 8-hour
// section grant lapsed (or the password was rotated) while she wrote, so the
// action sent her through /gate; an answer was blank or over the length cap
// (?error=invalid_form); or the save failed (?error=submit_failed). The
// textareas were uncontrolled, and React resets a form's uncontrolled fields
// once its action finishes, so every one of these threw away a rubric or a
// reflection typed on a phone. The server cannot keep it -- nothing is written
// for a user whose grant has lapsed -- so the browser does
// (lib/observation/drafts.ts, DraftTextarea.tsx).
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The storage functions against a Storage stand-in; the component through
// ./_ui.ts mount() (its own hooks, real handlers); and the key the REAL page
// renders, before and after the REAL actions refuse or accept a submission.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, mount, openingTags, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { draftScope, readDraft, saveDraft } from "../../apps/web/src/lib/observation/drafts.ts";

const skip = needsDatabase();
after(closeAppDb);

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  keys() { return [...this.m.keys()]; }
}

test("a draft comes back for the same version of the cycle, never for a later one or another user", () => {
  const s = new MemoryStorage();
  const mine = draftScope("user-a", "cycle-1", "note");
  const theirs = draftScope("user-b", "cycle-1", "note");
  saveDraft(s, mine, "100", "half a rubric");
  saveDraft(s, theirs, "100", "someone else's text");

  assert.equal(readDraft(s, mine, "100"), "half a rubric", "refused, nothing saved: the text comes back");
  assert.equal(readDraft(s, mine, "200"), null, "the cycle moved on (the text was saved): nothing comes back");
  assert.equal(readDraft(s, theirs, "200"), null);

  saveDraft(s, mine, "200", "x");
  assert.equal(s.getItem(mine + "100"), null, "typing against the new version clears the stale draft");
  assert.equal(s.getItem(theirs + "100"), "someone else's text", "another user's draft is neither shown nor touched");
  saveDraft(s, mine, "200", "   ");
  assert.equal(s.getItem(mine + "200"), null, "an emptied box leaves nothing behind");
});

test("the textarea is controlled and saves what is typed", async () => {
  const { DraftTextarea } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/DraftTextarea.tsx");
  const g = globalThis as Record<string, unknown>;
  const store = new MemoryStorage();
  g.window = { sessionStorage: store };
  try {
    const scope = draftScope("u", "c", "narrativeComments");
    const props = { name: "narrativeComments", draftScope: scope, draftVersion: "7" };
    const m = mount(DraftTextarea as never, props as never);
    const tree = m.tree as unknown as { type: string; props: Record<string, unknown> };
    assert.equal(tree.type, "textarea");
    assert.equal(tree.props.value, "", "controlled: React's form reset cannot empty it");
    (tree.props.onChange as (e: unknown) => void)({ currentTarget: { value: "Pupils answered in pairs" } });
    const after = m.rerender() as unknown as { props: Record<string, unknown> };
    assert.equal(after.props.value, "Pupils answered in pairs", "the typed text stays in the box");
    assert.equal(store.getItem(scope + "7"), "Pupils answered in pairs", "and is kept for the tab");
    assert.equal(after.props.name, "narrativeComments", "the form still posts it under its own name");

    // Storage that throws (private mode) must not break typing.
    g.window = { get sessionStorage() { throw new Error("blocked"); } };
    (after.props.onChange as (e: unknown) => void)({ currentTarget: { value: "still typing" } });
    assert.equal((m.rerender() as unknown as { props: Record<string, unknown> }).props.value, "still typing");

    // The page re-renders with the cycle's next version once the text was saved.
    g.window = { sessionStorage: store };
    props.draftVersion = "8";
    assert.equal((m.rerender() as unknown as { props: Record<string, unknown> }).props.value, "", "saved text does not stay in the box");
  } finally {
    delete g.window;
  }
});

async function draftKeys(user: TestUser, cycleId: string): Promise<Record<string, string | null>> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })),
  );
  return Object.fromEntries(openingTags(html, "textarea").map((t) => [attr(t, "name") ?? "?", attr(t, "data-draft-key")]));
}

test("the page keys each draft to its user, cycle and version; only a saved submission moves it", { skip }, async () => {
  const w = await observationWorld("obsdraft");
  try {
    const { submitObserverFormAction, addNoteAction } = await import(
      "../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts"
    );
    const cyc = await w.cycle({ status: "pre_submitted" });
    const before = await draftKeys(w.observer, cyc.id);
    assert.ok(before.narrativeComments?.startsWith(draftScope(w.observer.id, cyc.id, "narrativeComments")), JSON.stringify(before));
    assert.ok(before.note?.startsWith(draftScope(w.observer.id, cyc.id, "note")), JSON.stringify(before));

    // The grant lapsed while she wrote: sent to the gate, nothing written.
    signIn(w.observer);
    const lapsed = await outcome(() => submitObserverFormAction(form({ cycleId: cyc.id, narrativeComments: "Long rubric" })));
    assert.deepEqual(lapsed, { kind: "redirect", location: `/gate/observation?next=${encodeURIComponent(`/observation/${cyc.id}`)}` });
    assert.deepEqual(await draftKeys(w.observer, cyc.id), before, "same version after the gate: her text is restored");

    // Refused as invalid: nothing written either.
    await w.grant(w.observer.id);
    signIn(w.observer);
    const invalid = await outcome(() => submitObserverFormAction(form({ cycleId: cyc.id, narrativeComments: "x".repeat(5001) })));
    assert.match((invalid as { location: string }).location, /error=invalid_form/);
    assert.deepEqual(await draftKeys(w.observer, cyc.id), before, "same version after a refusal: her text is restored");

    // A note that WAS saved moves the version, so it does not come back.
    signIn(w.observer);
    await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "Saved note" })));
    const afterNote = await draftKeys(w.observer, cyc.id);
    assert.notEqual(afterNote.note, before.note, "a saved note is not restored into the box");
    assert.ok(afterNote.note?.startsWith(draftScope(w.observer.id, cyc.id, "note")));
  } finally {
    await w.cleanup();
  }
});
