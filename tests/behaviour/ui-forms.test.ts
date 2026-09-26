// The two form runners, desktop and mobile, rendered for real: the same seeded
// form must carry the same Hindi text on both, and the desktop submit must not
// race its own final autosave. See _ui.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, renderSync, elements, openingTags, attr, mount, hostElements } from "./_ui.js";

const noop = async () => undefined;

// Shaped exactly like packages/db/src/scripts/seed_forms_mentee.ts rows after
// its canonical field mapper (hindiLabel / helpHindi / option-level hindiLabel).
const HINDI_FORM = {
  fields: [
    {
      name: "years_teaching",
      label: "How many years have you been teaching?",
      hindiLabel: "आप कितने वर्षों से पढ़ा रहे हैं?",
      kind: "number",
      required: true,
      helpText: "e.g. 3",
      helpHindi: "उदा. 3",
    },
    {
      name: "would_recommend",
      label: "Would you recommend mentorship to a colleague?",
      hindiLabel: "क्या आप किसी सहकर्मी को मेंटरशिप की सिफ़ारिश करेंगे?",
      kind: "radio",
      options: [
        { value: "yes", label: "Yes", hindiLabel: "हाँ" },
        { value: "no", label: "No", hindiLabel: "नहीं" },
      ],
    },
    {
      name: "days",
      label: "Which days?",
      kind: "checkbox",
      options: [{ value: "mon", label: "Monday", hindiLabel: "सोमवार" }],
    },
    {
      name: "grade",
      label: "Grade",
      kind: "select",
      options: [{ value: "g1", label: "Grade 1", hindiLabel: "कक्षा 1" }],
    },
  ],
};

/**
 * Spans declared lang="hi" and their text. Matched directly (not via
 * `elements`) because option labels nest the Hindi span inside another span.
 */
function hindiRuns(html: string): Array<{ open: string; text: string }> {
  return [...html.matchAll(/(<span\b[^>]*\slang="hi"[^>]*>)([^<]*)<\/span>/g)].map((m) => ({
    open: m[1],
    text: m[2].replace(/&amp;/g, "&"),
  }));
}

// ── Defect D4: hindiLabel on desktop, and the Hindi text neither runner showed ──

test("D4: the desktop form renders each field's Hindi prompt, declared as Hindi", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(h(FormRenderer, { schema: HINDI_FORM, onSubmit: noop }));
  const runs = hindiRuns(html).map((r) => r.text);
  assert.ok(runs.includes("आप कितने वर्षों से पढ़ा रहे हैं?"), "the field-level hindiLabel must render on desktop, as it does on mobile");
  assert.ok(runs.includes("क्या आप किसी सहकर्मी को मेंटरशिप की सिफ़ारिश करेंगे?"));
});

test("D4: the desktop Hindi prompt undoes the label's uppercase mono letter-spacing", async () => {
  // Letter-spacing splits Devanagari matras from their base glyph, and the
  // label style it would otherwise inherit is 11px uppercase mono.
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(h(FormRenderer, { schema: HINDI_FORM, onSubmit: noop }));
  const run = hindiRuns(html).find((r) => r.text === "आप कितने वर्षों से पढ़ा रहे हैं?")!;
  const style = attr(run.open, "style") ?? "";
  assert.match(style, /letter-spacing:normal/);
  assert.match(style, /text-transform:none/);
  assert.match(style, /font-family:var\(--deva\)/);
});

test("D4: option-level hindiLabel and helpHindi render on desktop", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(h(FormRenderer, { schema: HINDI_FORM, onSubmit: noop }));
  const runs = hindiRuns(html).map((r) => r.text);
  for (const s of ["हाँ", "नहीं", "सोमवार", "उदा. 3"]) {
    assert.ok(runs.includes(s), `"${s}" must render, marked lang="hi"`);
  }
  const option = elements(html, "option").find((o) => attr(o.open, "value") === "g1")!;
  assert.match(option.text, /कक्षा 1/, "a <select> option cannot hold a span, so its Hindi label joins the text");
});

test("D4: the mobile form renders the same Hindi text, declared as Hindi", async () => {
  const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  // The mobile runner shows one question per screen; render each as step 0.
  const expectations: Record<string, string[]> = {
    years_teaching: ["आप कितने वर्षों से पढ़ा रहे हैं?", "उदा. 3"],
    would_recommend: ["क्या आप किसी सहकर्मी को मेंटरशिप की सिफ़ारिश करेंगे?", "हाँ", "नहीं"],
    days: ["सोमवार"],
  };
  for (const [name, wanted] of Object.entries(expectations)) {
    const schema = { fields: [HINDI_FORM.fields.find((f) => f.name === name)!] };
    const html = renderSync(h(MobileFormRunner, { schema, onSubmit: noop }));
    const runs = hindiRuns(html).map((r) => r.text);
    for (const s of wanted) assert.ok(runs.includes(s), `mobile ${name}: "${s}" must render with lang="hi"`);
  }
  const schema = { fields: [HINDI_FORM.fields.find((f) => f.name === "grade")!] };
  const html = renderSync(h(MobileFormRunner, { schema, onSubmit: noop }));
  const option = elements(html, "option").find((o) => attr(o.open, "value") === "g1")!;
  assert.match(option.text, /कक्षा 1/);
});

test("D4: a form with no Hindi renders no empty Hindi spans", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(h(FormRenderer, { schema: { fields: [{ name: "a", label: "A", kind: "radio", options: ["x", "y"] }] }, onSubmit: noop }));
  assert.equal(openingTags(html, "span").filter((t) => attr(t, "lang") === "hi").length, 0);
});

// ── Defect D10: the desktop submit awaits its final autosave ─────────────────

type FakeEvent = { defaultPrevented: boolean; preventDefault(): void };
const fakeEvent = (): FakeEvent => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("D10: the desktop server-action submit holds the POST until the final draft PUT has landed", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const log: string[] = [];
  const putLanded = deferred();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    await putLanded.promise;
    log.push("PUT landed");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const m = mount(FormRenderer as (p: unknown) => unknown, {
      schema: { fields: [{ name: "note", label: "Note", kind: "text" }] },
      initialResponses: { note: "last keystrokes" },
      draftKey: { templateId: "tpl-1" },
      action: async () => undefined,
    });
    const form = hostElements(m.tree).find((el) => el.type === "form")!;
    // The browser's form: requestSubmit() re-dispatches submit through the
    // SAME onSubmit handler, which is what makes a naive port loop forever.
    let posted = 0;
    const onSubmit = () => (hostElements(m.tree).find((el) => el.type === "form")!.props.onSubmit as (e: FakeEvent) => unknown);
    const fakeForm = {
      requestSubmit() {
        log.push("requestSubmit");
        const e = fakeEvent();
        void onSubmit()(e);
        // React dispatches the action only for a submit nobody prevented.
        if (!e.defaultPrevented) {
          posted += 1;
          log.push("action dispatched");
        }
      },
    };
    const ref = form.props.ref as { current: unknown } | undefined;
    if (ref && typeof ref === "object") ref.current = fakeForm;

    const first = fakeEvent();
    const pending = onSubmit()(first);
    // Synchronously: the native submit must be held, or React posts NOW --
    // while the PUT is still in flight, which is the race.
    if (!first.defaultPrevented) {
      posted += 1;
      log.push("action dispatched");
    }
    assert.equal(first.defaultPrevented, true, `the first submit must be held back while the draft is flushed (order so far: ${log.join(" → ")})`);
    assert.equal(posted, 0);
    assert.ok(ref && typeof ref === "object", "the form must hold a ref so the handler can re-submit it after the flush");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posted, 0, "nothing may post while the final PUT is still in flight");
    putLanded.resolve();
    await pending;
    assert.equal(posted, 1, "once the PUT has landed the form must post exactly once (no re-entry loop)");
    assert.deepEqual(log, [
      "PUT /api/form-drafts/tpl-1?scope=template",
      "PUT landed",
      "requestSubmit",
      "action dispatched",
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("D10: a failed final PUT still submits — the answers are in the POST either way", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  try {
    const m = mount(FormRenderer as (p: unknown) => unknown, {
      schema: { fields: [{ name: "note", label: "Note", kind: "text" }] },
      initialResponses: { note: "x" },
      draftKey: { templateId: "tpl-1" },
      action: async () => undefined,
    });
    const onSubmit = () => (hostElements(m.tree).find((el) => el.type === "form")!.props.onSubmit as (e: FakeEvent) => unknown);
    let posted = 0;
    (hostElements(m.tree).find((el) => el.type === "form")!.props.ref as { current: unknown }).current = {
      requestSubmit() {
        const e = fakeEvent();
        void onSubmit()(e);
        if (!e.defaultPrevented) posted += 1;
      },
    };
    await onSubmit()(fakeEvent());
    assert.equal(posted, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("D10: a submit that fails client validation never reaches the server, and is not left half-armed", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const m = mount(FormRenderer as (p: unknown) => unknown, {
    schema: { fields: [{ name: "note", label: "Note", kind: "text", required: true }] },
    initialResponses: {},
    action: async () => undefined,
  });
  let requested = 0;
  (hostElements(m.tree).find((el) => el.type === "form")!.props.ref as { current: unknown }).current = {
    requestSubmit() {
      requested += 1;
    },
  };
  const e = fakeEvent();
  await (hostElements(m.tree).find((el) => el.type === "form")!.props.onSubmit as (e: FakeEvent) => unknown)(e);
  assert.equal(e.defaultPrevented, true);
  assert.equal(requested, 0);
});
