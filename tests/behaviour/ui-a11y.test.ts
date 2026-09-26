// What assistive technology is told about a choice, read off the rendered
// markup of the real quiz and form runners: pressed state, group names, and
// labels that point at something. See _ui.ts. (Nav landmarks and the skip
// link are in ui-navigation.test.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, renderSync, elements, openingTags, attr, mount, hostElements, textOf } from "./_ui.js";

const noop = async () => undefined;
const QUESTIONS = [{ id: "q1", prompt: "Which is a vowel?", options: ["Apple", "Bat", "Cat", "Dog"] }];

/** Every <label for=X> must name an element that exists; a dangling label names nothing. */
function assertNoDanglingLabels(html: string, where: string) {
  const ids = new Set(openingTags(html, "[a-z]+").map((t) => attr(t, "id")).filter(Boolean));
  for (const label of openingTags(html, "label")) {
    const target = attr(label, "for");
    if (target === null) continue;
    assert.ok(ids.has(target), `${where}: <label for="${target}"> points at no element, so the control it sits over has no accessible name from it`);
  }
}

// ── Defect D3: selection must be exposed, not only painted ───────────────────

test("D3: every desktop quiz option exposes its pressed state", async () => {
  const { QuizRunner } = await import("../../apps/web/src/components/quiz/QuizRunner.tsx");
  const html = renderSync(h(QuizRunner, { slug: "s", title: "T", questions: QUESTIONS, submitAction: noop }));
  const options = elements(html, "button").filter((b) => /^[A-D](Apple|Bat|Cat|Dog)$/.test(b.text));
  assert.equal(options.length, 4, "four option buttons must render");
  for (const o of options) {
    assert.equal(attr(o.open, "aria-pressed"), "false", `option "${o.text}" must say aria-pressed="false" before anything is picked`);
    assert.equal(attr(o.open, "role"), null, "options must stay buttons: role=radio without roving tabindex breaks Tab traversal");
  }
});

test("D3: every mobile quiz option exposes its pressed state", async () => {
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  const html = renderSync(h(MobileQuizRunner, { slug: "s", title: "T", questions: QUESTIONS, submitAction: noop }));
  const options = openingTags(html, "button").filter((t) => /mobile-quiz-option-\d/.test(attr(t, "data-testid") ?? ""));
  assert.equal(options.length, 4);
  for (const o of options) {
    assert.equal(attr(o, "aria-pressed"), "false");
    assert.equal(attr(o, "role"), null);
  }
});

test("D3: picking a quiz option flips exactly that option to aria-pressed=true (desktop and mobile)", async () => {
  const { QuizRunner } = await import("../../apps/web/src/components/quiz/QuizRunner.tsx");
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  for (const [name, Runner] of [["QuizRunner", QuizRunner], ["MobileQuizRunner", MobileQuizRunner]] as const) {
    const m = mount(Runner as (p: unknown) => unknown, { slug: "s", title: "T", questions: QUESTIONS, submitAction: noop });
    const options = () =>
      hostElements(m.tree).filter((el) => el.type === "button" && /^[A-D](Apple|Bat|Cat|Dog)$/.test(textOf(el)));
    assert.equal(options().length, 4, `${name}: four options`);
    (options()[1].props.onClick as () => void)();
    m.rerender();
    assert.deepEqual(
      options().map((el) => el.props["aria-pressed"]),
      [false, true, false, false],
      `${name}: after picking B, only B may announce as pressed`,
    );
    (options()[3].props.onClick as () => void)();
    m.rerender();
    assert.deepEqual(options().map((el) => el.props["aria-pressed"]), [false, false, false, true], `${name}: changing the answer moves the pressed state`);
  }
});

const SCALE_SCHEMA = {
  fields: [
    { name: "confidence", label: "How confident do you feel?", kind: "likert", required: true },
    { name: "stars", label: "Rate the session", kind: "rating" },
    { name: "grade", label: "Grade", kind: "radio", options: ["1", "2"] },
    { name: "days", label: "Days", kind: "checkbox", options: ["Mon", "Tue"] },
    { name: "note", label: "Note", kind: "text" },
  ],
};

test("D3: desktop Likert — the chosen point is aria-pressed, the group is named", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  // A prior SUBMITTED answer arrives as a string — the real restore path.
  const html = renderSync(h(FormRenderer, { schema: SCALE_SCHEMA, initialResponses: { confidence: "4", stars: 3 }, onSubmit: noop }));
  const group = openingTags(html, "div").find((t) => attr(t, "aria-label") === "How confident do you feel?");
  assert.ok(group, "the Likert row must carry the field label as its accessible name");
  assert.equal(attr(group, "role"), "group");
  const points = elements(html, "button").filter((b) => /^[1-5](Strongly disagree|Disagree|Neutral|Agree|Strongly agree)$/.test(b.text));
  assert.equal(points.length, 5);
  assert.deepEqual(points.map((p) => attr(p.open, "aria-pressed")), ["false", "false", "false", "true", "false"]);
});

test("D3: desktop Rating — the chosen star says so in its name, once; the group is named", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(h(FormRenderer, { schema: SCALE_SCHEMA, initialResponses: { stars: 3 }, onSubmit: noop }));
  const group = openingTags(html, "div").find((t) => attr(t, "aria-label") === "Rate the session");
  assert.ok(group, "the rating row must carry the field label as its accessible name");
  assert.equal(attr(group, "role"), "group");
  const stars = openingTags(html, "button").filter((t) => /^Rate \d of 5/.test(attr(t, "aria-label") ?? ""));
  assert.deepEqual(stars.map((t) => attr(t, "aria-label")), [
    "Rate 1 of 5",
    "Rate 2 of 5",
    "Rate 3 of 5 (selected)",
    "Rate 4 of 5",
    "Rate 5 of 5",
  ]);
  // Cumulative "on" state must not be exposed as pressed: 1..3 would all
  // announce "pressed", which reads as three separate answers.
  assert.ok(stars.every((t) => attr(t, "aria-pressed") === null), "rating stars carry their state in the name only");
});

test("D3: desktop form — no <label> points at a control that does not exist", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = renderSync(h(FormRenderer, { schema: SCALE_SCHEMA, onSubmit: noop }));
  assertNoDanglingLabels(html, "FormRenderer");
  const checkboxGroup = openingTags(html, "div").find((t) => attr(t, "aria-label") === "Days");
  assert.ok(checkboxGroup && attr(checkboxGroup, "role") === "group", "a checkbox group must be a named group too");
});

test("D3: mobile Likert and Rating — pressed state, named groups, no dangling label", async () => {
  const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  for (const [first, initial] of [
    ["confidence", { confidence: "4" }],
    ["stars", { stars: "3" }],
    ["grade", {}],
    ["days", {}],
  ] as const) {
    const schema = { fields: [SCALE_SCHEMA.fields.find((f) => f.name === first)!] };
    const html = renderSync(h(MobileFormRunner, { schema, initialResponses: initial, onSubmit: noop }));
    assertNoDanglingLabels(html, `MobileFormRunner(${first})`);
    const label = schema.fields[0].label;
    const group = openingTags(html, "div").find((t) => attr(t, "aria-label") === label);
    assert.ok(group, `${first}: the control group must be named by the field label`);
    if (first === "confidence") {
      assert.equal(attr(group, "role"), "group");
      const points = openingTags(html, "button").filter((t) => /mobile-likert-confidence-\d/.test(attr(t, "data-testid") ?? ""));
      assert.deepEqual(points.map((t) => attr(t, "aria-pressed")), ["false", "false", "false", "true", "false"]);
    }
    if (first === "stars") {
      assert.equal(attr(group, "role"), "group");
      const stars = openingTags(html, "button").filter((t) => /mobile-star-stars-\d/.test(attr(t, "data-testid") ?? ""));
      assert.deepEqual(stars.map((t) => attr(t, "aria-label")), [
        "Rate 1 of 5",
        "Rate 2 of 5",
        "Rate 3 of 5 (selected)",
        "Rate 4 of 5",
        "Rate 5 of 5",
      ]);
    }
  }
});
