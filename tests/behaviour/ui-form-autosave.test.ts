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

const USER = "33333333-3333-4333-8333-333333333333";

type MountOpts = {
  /** Whose device copy (the runner page passes the signed-in user). */
  userId?: string;
  /** When the server last wrote what initialResponses hold (ms), or null. */
  serverSavedAt?: number | null;
  initialResponses?: Record<string, unknown>;
  /** Run effects: the restore-on-mount and the `online` listener live there. */
  effects?: boolean;
};

async function mountRunner(which: Runner, opts: MountOpts = {}) {
  const mod =
    which === "FormRenderer"
      ? await import("../../apps/web/src/components/forms/FormRenderer.tsx")
      : await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  const component = (mod as Record<string, unknown>)[which] as (p: unknown) => unknown;
  const m = mount(
    component,
    {
      schema: { fields: [{ name: "note", label: "Note", kind: "textarea" }] },
      initialResponses: opts.initialResponses ?? {},
      draftKey: KEY,
      userId: opts.userId ?? USER,
      serverSavedAt: opts.serverSavedAt ?? null,
      action: async () => undefined,
    },
    { effects: opts.effects },
  );
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
  const note = () => {
    const box = allElements(m.rerender()).find(
      (el) => (el.props.field as { name?: string } | undefined)?.name === "note" && "value" in el.props,
    )!;
    return box.props.value;
  };
  return { m, type, indicator, note };
}

/** PUT bodies' `note`, and a fetch that answers each call with `status(n)`. */
function recordPuts(status: (n: number) => number | "offline" = () => 200) {
  const notes: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    notes.push((JSON.parse(init?.body ?? "{}") as { responses?: { note?: unknown } }).responses?.note);
    const st = status(notes.length);
    if (st === "offline") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: st });
  }) as typeof fetch;
  return notes;
}

/**
 * Leave a copy on this device the way a real failure does: the answer is
 * typed, the save is refused for good (401), and the tab is closed.
 */
async function leaveDeviceCopy(which: Runner, text: string, userId = USER) {
  recordPuts(() => 401);
  const first = await mountRunner(which, { userId });
  first.type(text);
  await sleep(1300);
  first.m.unmount();
  assert.match([...storage.map.values()].join(""), new RegExp(text), "precondition: a copy is on the device");
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

// ── W3-30: a save still in flight when Submit or unmount happens ─────────────
//
// cancelRetry() and the unmount cleanup cleared only a retry timer already
// pending. A PUT still on the wire -- the debounced save a second before
// Submit, or any save when the user navigates away -- reached its catch later,
// kept its device copy and scheduled a fresh retry that nothing cleared, which
// then PUT the draft back after the submit transaction had deleted it: "Draft
// loaded" over a submitted form on the next visit, and retries with backoff
// for the rest of the session. And the Submit's `await flushSave()` waited
// only for its own PUT, so even a late SUCCESS of the earlier one could land
// after the POST.

/**
 * A fetch whose first PUT hangs until `release`d (a 503 or a dead link), and
 * whose later PUTs answer `later(n)`. `events` records each PUT as it is sent
 * and each POST (requestSubmit) as it is dispatched, in order.
 */
function heldFirstPut(later: (n: number) => number | "offline" = () => 200) {
  const events: string[] = [];
  let n = 0;
  let release!: (how: "503" | "offline" | "200") => void;
  globalThis.fetch = (async () => {
    n += 1;
    events.push(`PUT ${n}`);
    if (n === 1) {
      return new Promise<Response>((resolve, reject) => {
        release = (how) => {
          events.push(`PUT 1 -> ${how}`);
          if (how === "offline") reject(new TypeError("Failed to fetch"));
          else resolve(new Response("{}", { status: Number(how) }));
        };
      });
    }
    const st = later(n);
    if (st === "offline") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: st });
  }) as typeof fetch;
  return { events, puts: () => n, release: (how: "503" | "offline" | "200") => release(how) };
}

/** Press the runner's Submit, with requestSubmit() recorded as the POST. */
function pressSubmit(which: Runner, m: { rerender(): unknown }, events: string[]): Promise<void> {
  const tree = () => hostElements(m.rerender());
  if (which === "MobileFormRunner") {
    // One field: Next goes to the review screen, where Submit lives.
    (tree().find((el) => el.props["data-testid"] === "mobile-form-next")!.props.onClick as () => void)();
  }
  const form = tree().find((el) => el.type === "form")!;
  (form.props.ref as { current: unknown }).current = { requestSubmit: () => events.push("POST") };
  if (which === "FormRenderer") {
    return (form.props.onSubmit as (e: { defaultPrevented: boolean; preventDefault(): void }) => Promise<void>)({
      defaultPrevented: false,
      preventDefault() {},
    });
  }
  return (tree().find((el) => el.props["data-testid"] === "mobile-form-submit")!.props.onClick as () => Promise<void>)();
}

for (const which of ["FormRenderer", "MobileFormRunner"] as const) {
  for (const how of ["503", "offline"] as const) {
    test(`${which}: a save in flight at Submit that then fails (${how}) sends no PUT after the POST`, async () => {
      const f = heldFirstPut();
      const r = await mountRunner(which, { effects: true });
      r.type("final answer");
      await sleep(1150); // the debounced PUT is on the wire
      assert.equal(f.puts(), 1, "precondition: a save in flight");
      const submitted = pressSubmit(which, r.m, f.events);
      await sleep(20);
      f.release(how);
      await submitted;
      assert.ok(f.events.includes("POST"), `the form is submitted: ${f.events.join(", ")}`);
      r.m.unmount(); // the redirect to /thanks
      await sleep(2600); // past the first retry's backoff
      const sentAfterPost = f.events.slice(f.events.indexOf("POST") + 1).filter((e) => /^PUT \d+$/.test(e));
      assert.deepEqual(sentAfterPost, [], `no draft PUT may follow the submission: ${f.events.join(", ")}`);
    });
  }

  test(`${which}: the POST waits for a save already in flight, so a late success cannot land after it`, async () => {
    const f = heldFirstPut();
    const r = await mountRunner(which, { effects: true });
    r.type("final answer");
    await sleep(1150);
    const submitted = pressSubmit(which, r.m, f.events);
    await sleep(20);
    f.release("200");
    await submitted;
    r.m.unmount();
    assert.ok(
      f.events.indexOf("PUT 1 -> 200") < f.events.indexOf("POST"),
      `the earlier save has settled before the POST leaves: ${f.events.join(", ")}`,
    );
  });

  test(`${which}: a save in flight at unmount that then fails is not retried`, async () => {
    const f = heldFirstPut();
    const r = await mountRunner(which, { effects: true });
    r.type("half done");
    await sleep(1150);
    assert.equal(f.puts(), 1);
    r.m.unmount(); // navigated away
    f.release("offline");
    await sleep(2600);
    assert.equal(f.puts(), 1, `no PUT from a runner that is gone: ${f.events.join(", ")}`);
  });

  test(`${which}: when every save fails, as on a dropped link, nothing is sent after the POST`, async () => {
    const f = heldFirstPut(() => "offline");
    const r = await mountRunner(which, { effects: true });
    r.type("final answer");
    await sleep(1150);
    const submitted = pressSubmit(which, r.m, f.events);
    await sleep(20);
    f.release("offline");
    await submitted;
    r.m.unmount();
    // Two failures in a row: the second retry's backoff is 4 s.
    await sleep(4600);
    const sentAfterPost = f.events.slice(f.events.indexOf("POST") + 1).filter((e) => /^PUT \d+$/.test(e));
    assert.deepEqual(sentAfterPost, [], `no draft PUT may follow the submission: ${f.events.join(", ")}`);
  });
}

test("FormRenderer (callback submit): a save started while onSubmit ran is not retried after it", async () => {
  // Preview surfaces submit through an `onSubmit` callback. A save that starts
  // while it runs -- here the browser coming back online with a copy waiting
  // -- is in flight when cancelRetry() runs, and must not retry afterwards.
  const win = new EventTarget();
  g.window = win;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { method?: string }) => {
    methods.push(init?.method ?? "GET");
    if (init?.method !== "PUT") return new Response("{}", { status: 200 });
    await sleep(50);
    return new Response("busy", { status: 503 });
  }) as typeof fetch;
  let finishSubmit!: () => void;
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const m = mount(
    FormRenderer as (p: unknown) => unknown,
    {
      schema: { fields: [{ name: "note", label: "Note", kind: "textarea" }] },
      initialResponses: { note: "an answer" },
      draftKey: KEY,
      userId: USER,
      serverSavedAt: null,
      onSubmit: () => new Promise<void>((done) => (finishSubmit = done)),
    },
    { effects: true },
  );
  try {
    const form = hostElements(m.rerender()).find((el) => el.type === "form")!;
    const submitted = (form.props.onSubmit as (e: { defaultPrevented: boolean; preventDefault(): void }) => Promise<void>)({
      defaultPrevented: false,
      preventDefault() {},
    });
    await sleep(100); // the flush before onSubmit: a 503, so a copy stays on the device
    assert.deepEqual(methods, ["PUT"]);
    m.rerender();
    win.dispatchEvent(new Event("online")); // a save starts while onSubmit runs
    await sleep(10);
    assert.deepEqual(methods, ["PUT", "PUT"]);
    finishSubmit();
    await submitted; // cancelRetry(), then the draft is cleared
    await sleep(4600); // past both backoffs
    assert.deepEqual(methods.filter((x) => x === "PUT"), ["PUT", "PUT"], `no PUT after the submission: ${methods.join(", ")}`);
  } finally {
    m.unmount();
    delete g.window;
  }
});

test("FormRenderer: after a submit the server sent back, a failing autosave is still retried", async () => {
  // A rejected server action (?error=...) leaves the runner mounted, and its
  // later autosaves must still recover: cancelRetry is not a one-way switch.
  const puts = recordPuts((n) => (n === 2 ? 503 : 200));
  const r = await mountRunner("FormRenderer", { effects: true });
  try {
    await pressSubmit("FormRenderer", r.m, []);
    assert.equal(puts.length, 1, "the flush before the POST");
    r.type("corrected answer");
    await sleep(1300); // debounce -> PUT 2, a 503
    assert.equal(puts.length, 2);
    await sleep(2500); // the retry
    assert.equal(puts.length, 3, "the failed save is retried");
  } finally {
    r.m.unmount();
  }
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

// ── F58 (review): the device copy, on the next visit ─────────────────────────
//
// The copy was restored over whatever the server handed the page, and PUT at
// once, without comparing its time with the server's: a stale copy on one
// phone (saves failed there, the work went on and was saved elsewhere)
// silently replaced the newer draft. Its key had no user in it, so on a shared
// school phone one teacher's copy was restored into another's form. And a
// 400, 404 or 413 was retried forever.

for (const which of ["FormRenderer", "MobileFormRunner"] as const) {
  test(`${which}: a device copy newer than the server's draft is restored and sent`, async () => {
    await leaveDeviceCopy(which, "typed offline, never saved");
    const puts = recordPuts();
    const r = await mountRunner(which, {
      initialResponses: { note: "the server's older draft" },
      serverSavedAt: Date.now() - 60_000,
      effects: true,
    });
    try {
      await sleep(50);
      assert.equal(r.note(), "typed offline, never saved", "the newer copy is what the form shows");
      assert.deepEqual(puts, ["typed offline, never saved"], "and it goes to the server at once");
      assert.equal(storage.map.size, 0, "once the server has it, the device copy is cleared");
    } finally {
      r.m.unmount();
    }
  });

  test(`${which}: a device copy older than the server's draft is dropped, not restored`, async () => {
    await leaveDeviceCopy(which, "stale, from before the other device");
    const puts = recordPuts();
    const r = await mountRunner(which, {
      initialResponses: { note: "saved later on another device" },
      serverSavedAt: Date.now() + 60_000,
      effects: true,
    });
    try {
      await sleep(50);
      assert.equal(r.note(), "saved later on another device", "the newer server draft stands");
      assert.deepEqual(puts, [], "nothing overwrites it");
      assert.equal(storage.map.size, 0, "the stale copy is removed from the device");
    } finally {
      r.m.unmount();
    }
  });

  test(`${which}: one user's device copy is never restored into another user's form`, async () => {
    await leaveDeviceCopy(which, "teacher one's answer", "44444444-4444-4444-8444-444444444444");
    const puts = recordPuts();
    const r = await mountRunner(which, { userId: USER, effects: true });
    try {
      await sleep(50);
      assert.notEqual(r.note(), "teacher one's answer");
      assert.deepEqual(puts, []);
    } finally {
      r.m.unmount();
    }
  });

  test(`${which}: coming back online sends the waiting copy at once`, async () => {
    const win = new EventTarget();
    g.window = win;
    try {
      const puts = recordPuts((n) => (n === 1 ? "offline" : 200));
      const r = await mountRunner(which, { effects: true });
      try {
        r.type("typed on a dead link");
        await sleep(1300); // debounce -> the PUT, which fails; a retry is due in 2 s
        assert.equal(puts.length, 1);
        r.m.rerender();
        win.dispatchEvent(new Event("online"));
        await sleep(50);
        assert.deepEqual(puts, ["typed on a dead link", "typed on a dead link"], "sent on 'online', not at the next backoff");
        assert.equal(storage.map.size, 0);
      } finally {
        r.m.unmount();
      }
    } finally {
      delete g.window;
    }
  });

  test(`${which}: a 4xx refusal is not retried; a 429 or 5xx is`, async () => {
    // With effects, so unmount() stops any retry left scheduled.
    const refused = recordPuts(() => 400);
    const a = await mountRunner(which, { effects: true });
    try {
      a.type("too long, say");
      await sleep(1300);
      assert.match(a.indicator(), /kept on this device/i);
      assert.doesNotMatch(a.indicator(), /retrying/i, "a 400 will not succeed by being repeated");
      await sleep(2500);
      assert.equal(refused.length, 1);
    } finally {
      a.m.unmount();
    }

    storage.map.clear();
    const busy = recordPuts((n) => (n === 1 ? 429 : 200));
    const b = await mountRunner(which, { effects: true });
    try {
      b.type("busy server");
      await sleep(1300);
      assert.match(b.indicator(), /retrying/i);
      await sleep(2500);
      assert.equal(busy.length, 2, "a 429 is tried again");
    } finally {
      b.m.unmount();
    }
  });
}
