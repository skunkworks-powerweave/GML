// What a form runner does when an autosave fails. EXECUTED against the real
// FormRenderer and MobileFormRunner (see _ui.ts mount); no database needed.
//
// ── F58 ──────────────────────────────────────────────────────────────────────
//
// flushSave caught every failure -- offline, a 401 after the session expired, a
// 500 -- set saveState "error" and rendered "Save failed — retrying…". Nothing
// retried: no timer, no backoff, no `online` listener, no copy anywhere but
// React state. The next save happened only on the next keystroke. On a Ladakh
// 2G link a teacher who typed her last answer while the connection was down
// and closed the tab lost it, having been told it was being retried. An
// expired session looked the same, so she kept typing into a form that could
// no longer save.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mount, hostElements, textOf } from "./_ui.js";

const KEY = { templateId: "11111111-1111-4111-8111-111111111111", pairingId: "22222222-2222-4222-8222-222222222222" };

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

let storage: MemoryStorage;
const realFetch = globalThis.fetch;
const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  storage = new MemoryStorage();
  g.localStorage = storage;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.localStorage;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type El = { type: unknown; props: Record<string, unknown> };
/** Every element in a returned tree, host or component, depth-first. */
function allElements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) allElements(n, out);
  else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as El;
    out.push(el);
    allElements(el.props.children, out);
  }
  return out;
}

type Runner = "FormRenderer" | "MobileFormRunner";

async function mountRunner(which: Runner) {
  const mod =
    which === "FormRenderer"
      ? await import("../../apps/web/src/components/forms/FormRenderer.tsx")
      : await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  const component = (mod as Record<string, unknown>)[which] as (p: unknown) => unknown;
  const m = mount(component, {
    schema: { fields: [{ name: "note", label: "Note", kind: "textarea" }] },
    initialResponses: {},
    draftKey: KEY,
    action: async () => undefined,
  });
  // The textarea is drawn by a child component (TextArea / BigTextArea), which
  // mount() leaves unexpanded; its element carries the runner's onChange.
  const type = (text: string) => {
    const box = allElements(m.rerender()).find(
      (el) => (el.props.field as { name?: string } | undefined)?.name === "note" && typeof el.props.onChange === "function",
    )!;
    (box.props.onChange as (v: string) => void)(text);
  };
  const indicator = () =>
    textOf(
      hostElements(m.rerender()).find(
        (el) => el.props["data-saved-indicator"] !== undefined || el.props["data-testid"] === "mobile-save-state",
      ),
    );
  return { m, type, indicator };
}

test("FormRenderer: a retry pending when Submit is pressed never lands after the POST", async () => {
  // The submit transaction deletes the draft; a PUT arriving after it would
  // re-create it, and the next visit would paint "Draft loaded" over a
  // submitted form.
  let puts = 0;
  globalThis.fetch = (async () => {
    puts += 1;
    return new Response("busy", { status: 503 });
  }) as typeof fetch;
  const { m } = await mountRunner("FormRenderer");
  const form = () => hostElements(m.rerender()).find((el) => el.type === "form")!;
  (form().props.ref as { current: unknown }).current = { requestSubmit() {} };
  await (form().props.onSubmit as (e: { defaultPrevented: boolean; preventDefault(): void }) => Promise<void>)({
    defaultPrevented: false,
    preventDefault() {},
  });
  assert.equal(puts, 1, "the final flush before the POST");
  await sleep(2500);
  assert.equal(puts, 1, "no draft PUT may follow the submission");
});

for (const which of ["FormRenderer", "MobileFormRunner"] as const) {
  test(`${which}: a failed autosave is retried without another keystroke, and a copy stays on the device`, async () => {
    const calls: number[] = [];
    globalThis.fetch = (async () => {
      calls.push(Date.now());
      if (calls.length === 1) throw new TypeError("Failed to fetch"); // offline
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { type, indicator } = await mountRunner(which);
    type("typed while the link was down");
    const local = () => [...storage.map.values()].join("");
    assert.match(local(), /typed while the link was down/, "every change is kept on the device at once");

    await sleep(1300); // debounce -> first PUT, which fails
    assert.equal(calls.length, 1);
    assert.match(indicator(), /kept on this device/i, "the indicator must not claim a retry that is not happening");
    assert.match(local(), /typed while the link was down/, "a failed save must leave the local copy in place");

    await sleep(3000); // the retry, with no keystroke in between
    assert.equal(calls.length, 2, "the failed save must be retried on its own");
    assert.doesNotMatch(indicator(), /kept on this device/i);
    assert.equal(local(), "", "once the server has the draft, the device copy is cleared");
  });

  test(`${which}: an expired session says so and stops retrying`, async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{"error":"unauthorized"}', { status: 401 });
    }) as typeof fetch;
    const { type, indicator } = await mountRunner(which);
    type("still typing");
    await sleep(1300);
    assert.match(indicator(), /sign in again/i);
    assert.match(indicator(), /kept on this device/i);
    await sleep(2500);
    assert.equal(calls, 1, "a 401 will not succeed by being repeated");
    assert.match([...storage.map.values()].join(""), /still typing/);
  });
}
