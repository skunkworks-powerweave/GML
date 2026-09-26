// The form runners' client-side checks agree with the server's, and a server
// rejection gives the Submit button back. EXECUTED against the real
// components (see _ui.ts); no database needed.
//
// ── F57 ──────────────────────────────────────────────────────────────────────
//
// The client checked only `required` and a number's min/max. The server also
// refuses text over 5000 characters, choices that are not options, too many
// selections and out-of-range scales -- so a long reflection pasted into a
// textarea (which had no maxLength) passed the client and came back from the
// server as ?error=invalid. Worse, both runners had set `submitting` and never
// reset it on the action path, on the stated assumption that "the page
// unmounts on success and re-renders on a validation redirect". In Next 16 a
// redirect that changes only the query string keeps the client component
// MOUNTED (the layout router's cache key drops search params), so the user
// saw the red banner above a disabled "Submitting…" button and could not
// correct and resubmit without reloading.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, renderSync, mount, hostElements, textOf, attr, openingTags } from "./_ui.js";

type FakeEvent = { defaultPrevented: boolean; preventDefault(): void };
const fakeEvent = (): FakeEvent => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

const LONG = "x".repeat(5001);

test("the desktop runner refuses a 5001-character answer before it reaches the server", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const m = mount(FormRenderer as (p: unknown) => unknown, {
    schema: { fields: [{ name: "reflection", label: "Reflection", kind: "textarea" }] },
    initialResponses: { reflection: LONG },
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
  assert.equal(e.defaultPrevented, true, "the POST must not go");
  assert.equal(requested, 0);
  const alert = hostElements(m.rerender()).find((el) => el.type === "div" && el.props.role === "alert");
  assert.match(textOf(alert), /too long/);
});

test("the mobile runner refuses an out-of-range scale answer the server would refuse", async () => {
  const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  const m = mount(MobileFormRunner as (p: unknown) => unknown, {
    schema: { fields: [{ name: "confidence", label: "Confidence", kind: "likert", required: true }] },
    initialResponses: { confidence: 9 },
    action: async () => undefined,
  });
  let requested = 0;
  (hostElements(m.tree).find((el) => el.type === "form")!.props.ref as { current: unknown }).current = {
    requestSubmit: () => (requested += 1),
  };
  const byTestId = (id: string) => hostElements(m.rerender()).find((el) => el.props["data-testid"] === id);
  // Step 0 is the field; "Review →" validates it and moves to the review
  // screen, which carries Submit.
  (byTestId("mobile-form-next")!.props.onClick as () => void)();
  const submit = byTestId("mobile-form-submit");
  if (submit) await (submit.props.onClick as () => Promise<void>)();
  assert.equal(requested, 0, "a 9 on a five-point scale must not be posted");
  const alert = hostElements(m.rerender()).find((el) => el.props.role === "alert");
  assert.match(textOf(alert), /at most 5/, "and the runner says why");
});

test("text inputs and textareas carry the server's 5000-character limit", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(
    h(FormRenderer, {
      schema: { fields: [{ name: "a", label: "A", kind: "text" }, { name: "b", label: "B", kind: "textarea" }] },
      onSubmit: async () => undefined,
    }),
  );
  for (const tag of [...openingTags(html, "input").filter((t) => attr(t, "name") === "a"), ...openingTags(html, "textarea")]) {
    assert.equal(attr(tag, "maxLength") ?? attr(tag, "maxlength"), "5000", tag);
  }
});

async function submitThenServerAnswers(component: (p: unknown) => unknown, findButton: (tree: unknown) => { props: Record<string, unknown> } | undefined) {
  const props: Record<string, unknown> = {
    schema: { fields: [{ name: "note", label: "Note", kind: "text" }] },
    initialResponses: { note: "answer" },
    action: async () => undefined,
  };
  const m = mount(component, props);
  // The mobile runner shows Submit on its review screen, one "Review →" away.
  const next = hostElements(m.tree).find((el) => el.props["data-testid"] === "mobile-form-next");
  if (next) {
    (next.props.onClick as () => void)();
    m.rerender();
  }
  const form = () => hostElements(m.tree).find((el) => el.type === "form")!;
  (form().props.ref as { current: unknown }).current = {
    requestSubmit() {
      const onSubmit = form().props.onSubmit as ((e: FakeEvent) => unknown) | undefined;
      onSubmit?.(fakeEvent());
    },
  };
  const button = findButton(m.tree)!;
  if (typeof form().props.onSubmit === "function" && button.props.type === "submit") {
    await (form().props.onSubmit as (e: FakeEvent) => Promise<void>)(fakeEvent());
  } else {
    await (button.props.onClick as () => Promise<void>)();
  }
  const inFlight = findButton(m.rerender())!;
  assert.equal(inFlight.props.disabled, true, "while the action is in flight a second tap must not post again");

  // The server's answer to a rejected submission: a redirect back to this
  // route, whose fresh render hands the STILL-MOUNTED runner new props.
  props.initialResponses = { note: "answer" };
  const after = findButton(m.rerender())!;
  assert.equal(after.props.disabled, false, "the button must come back after the server answers");
  assert.doesNotMatch(textOf(after), /Submitting/);
}

test("desktop: after the server rejects a submission, Submit is usable again", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  await submitThenServerAnswers(FormRenderer as (p: unknown) => unknown, (tree) =>
    hostElements(tree).find((el) => el.type === "button" && el.props.type === "submit"),
  );
});

test("mobile: after the server rejects a submission, Submit is usable again", async () => {
  const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  await submitThenServerAnswers(MobileFormRunner as (p: unknown) => unknown, (tree) =>
    hostElements(tree).find((el) => el.type === "button" && /Submit/.test(textOf(el))),
  );
});
