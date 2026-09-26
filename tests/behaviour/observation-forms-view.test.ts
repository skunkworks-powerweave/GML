// The observation cycle page shows what was SUBMITTED, to every party.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The cycle page loaded observation_forms and rendered each row as a kind chip
// and a timestamp -- nothing else. `responses` and `submitted_by_user_id` were
// never read by anything in the app. So the observer could not read the
// teacher's lesson plan before observing, the teacher never saw the observer's
// rubric narrative, and the mentor was offered "Sign off cycle" above three
// chips reading "pre Submitted / observer Submitted / post Submitted". Review
// and feedback -- the point of the cycle -- happened blind.
//
// The same table doubles as the store for the spec-077 seed TEMPLATES
// (submitted_by NULL, responses = { fields: [...] }), and the page could not
// tell one from a submission: a nominated cycle carrying templates announced
// "Forms · 3 ... Submitted" for forms nobody had filled in.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL page (observation/[cycleId]/page.tsx) is rendered for each party of
// a real cycle, through ./_server-actions.ts: auth() answers with the signed-in
// test user, and everything else -- the ownership check, the queries, the
// markup -- is the production code.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, renderSync, withAppRouter, h } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

const page = () => import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");

async function renderCycle(user: TestUser, cycleId: string, searchParams: Record<string, string> = {}): Promise<string> {
  signIn(user);
  const { default: CycleDetailPage } = await page();
  const tree = await CycleDetailPage({
    params: Promise.resolve({ cycleId }),
    searchParams: Promise.resolve(searchParams),
  });
  return render(withAppRouter(tree));
}

/** Visible text, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

test("every party of a cycle reads the submitted pre, observer and post forms, with who submitted each", { skip }, async () => {
  const w = await observationWorld("obsview");
  try {
    const cyc = await w.cycle({ status: "post_submitted" });
    const put = (kind: string, by: string, responses: Record<string, unknown>) =>
      w.c.query(
        `INSERT INTO observation_forms (cycle_id, kind, responses, submitted_by_user_id) VALUES ($1, $2, $3, $4)`,
        [cyc.id, kind, JSON.stringify(responses), by],
      );
    await put("pre", w.teacher.id, { lessonPlanSummary: `PRE-SENTINEL-${w.T} fractions on a number line` });
    await put("observer", w.observer.id, { narrativeComments: `OBS-SENTINEL-${w.T} good questioning` });
    await put("post", w.teacher.id, { whatWorked: `POST-SENTINEL-${w.T} the number line worked` });

    for (const viewer of [w.teacher, w.observer, w.mentor, w.admin]) {
      const out = text(await renderCycle(viewer, cyc.id));
      for (const sentinel of ["PRE", "OBS", "POST"]) {
        assert.ok(
          out.includes(`${sentinel}-SENTINEL-${w.T}`),
          `${viewer.role} cannot read the ${sentinel} form's answers on the cycle page`,
        );
      }
      assert.match(out, /Lesson plan summary/, `${viewer.role}: the answer is shown under its question`);
      assert.match(out, /Observer rubric notes/);
      assert.ok(out.includes(w.observer.name), `${viewer.role}: the observer form names who submitted it`);
      assert.ok(out.includes(w.teacher.name), `${viewer.role}: the pre/post forms name who submitted them`);
    }
  } finally {
    await w.cleanup();
  }
});

test("seed TEMPLATE rows are not submissions: not listed, not counted, not 'Submitted'", { skip }, async () => {
  const w = await observationWorld("obstpl");
  try {
    const cyc = await w.cycle({ status: "nominated" });
    for (const kind of ["pre", "observer", "post"]) {
      await w.c.query(
        `INSERT INTO observation_forms (cycle_id, kind, responses, submitted_by_user_id) VALUES ($1, $2, $3, NULL)`,
        [
          cyc.id,
          kind,
          JSON.stringify({
            description: `TEMPLATE-${w.T} ${kind}`,
            fields: [{ key: "lessonStructure", label: "Lesson structure", type: "scale", required: true }],
          }),
        ],
      );
    }
    const out = text(await renderCycle(w.admin, cyc.id));
    assert.match(out, /Forms · 0/, "a template is not a submitted form and must not be counted as one");
    assert.match(out, /No forms submitted yet/);
    assert.ok(!out.includes(`TEMPLATE-${w.T}`), "template JSON must never be printed as someone's answers");
    assert.doesNotMatch(out, /Submitted by|Submitted \d/, "nothing on a nominated cycle was submitted");
  } finally {
    await w.cleanup();
  }
});

test("SubmittedForms escapes answers and hides internal keys", async () => {
  const { SubmittedForms } = await import(
    "../../apps/web/src/app/(authenticated)/observation/[cycleId]/SubmittedForms.tsx"
  );
  const html = renderSync(
    h(SubmittedForms, {
      forms: [
        {
          id: "f1",
          kind: "observer",
          title: "Observer rubric",
          submittedAt: new Date("2026-09-24T10:00:00Z"),
          submitterName: "Observer <b>X</b>",
          onBehalf: false,
          entries: [{ label: "Observer rubric notes", value: "<script>alert(1)</script>\nline two" }],
        },
      ],
    }),
  );
  assert.ok(!html.includes("<script>"), "an answer is text, never markup");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<b>X</b>"));
  assert.match(html, /white-space:pre-wrap/, "line breaks a teacher typed survive rendering");
});

test("the form view drops templates, labels known fields, skips __ keys and joins lists", async () => {
  const { submittedFormView } = await import("../../apps/web/src/lib/observation/forms.ts");
  const at = new Date("2026-09-24T10:00:00Z");
  const view = submittedFormView(
    [
      { id: "t", kind: "pre", responses: { fields: [{ key: "x" }], description: "tpl" }, submittedAt: at, submittedByUserId: null, submitterName: null },
      { id: "p", kind: "post", responses: { whatWorked: "yes", __csrf: "no", extra: ["a", "b"] }, submittedAt: at, submittedByUserId: "u1", submitterName: "T" },
      { id: "o", kind: "observer", responses: { narrativeComments: "fine" }, submittedAt: at, submittedByUserId: "u2", submitterName: "O" },
    ],
    { teacherUserId: "u1" },
  );
  assert.deepEqual(view.map((f) => f.kind), ["observer", "post"], "templates dropped, stage order kept");
  const post = view.find((f) => f.kind === "post")!;
  assert.deepEqual(post.entries, [
    { label: "What worked / What didn't", value: "yes" },
    { label: "extra", value: "a\nb" },
  ]);
  assert.equal(post.onBehalf, false, "the teacher's own post-form is not 'on behalf'");
});
