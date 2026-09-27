// Classroom observation and the help panel, in Hindi and Bhoti.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// A user who picked Hindi or Bhoti got a translated menu over English pages:
// the observation list, the nomination form, the cycle page (its stepper, its
// errors, the forms read back, the notes), the inbox rows a nomination or a
// sign-off writes, and the whole ? help panel -- every article in the help
// dictionary -- stayed English. Their copy now lives in the "observation" and
// "help" namespaces.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL pages and components, rendered with the app's own bundles for the
// fake request's locale (./_ui.ts): each assertion finds a string from the
// namespace in the reader's language and not its English original. The pages
// and the notifications run against a committed observation programme
// (./_observation-world.ts); the client components need no database.

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb } from "./_server-actions.js";
import { h, mount, render, request, resetRequest, textOf, withAppRouter, withFakeWindow } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
after(closeAppDb);
afterEach(resetRequest);

type Tree = { [k: string]: string | Tree };
/** A message from the app's bundle for `locale`, by dotted path. */
function msg(locale: "en" | "hi" | "bo", path: string): string {
  const v = path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], loadMessages(locale));
  assert.equal(typeof v, "string", `${locale}:${path} is a message`);
  return v as string;
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

const LOCALES = ["hi", "bo"] as const;

// ── Client components: no database ──────────────────────────────────────────

test("the help panel opens on a topic in the reader's language", async () => {
  {
    const { HelpPanel, HELP_OPEN_EVENT } = await import("../../apps/web/src/components/help/HelpPanel.tsx");
    // The panel fetches its articles when it first opens (useHelpEntries);
    // here they are put in its cache, as the fetch would.
    const { primeHelpEntries } = await import("../../apps/web/src/components/help/useHelpEntries.ts");
    for (const l of LOCALES) primeHelpEntries(l, (loadMessages(l).help as unknown as { entries: Record<string, { title: string; short: string }> }).entries);
    const g = globalThis as Record<string, unknown>;
    const hadDocument = "document" in g;
    const previousDocument = g.document;
    // The panel's focus effect reads document.activeElement once it opens.
    g.document = { activeElement: null };
    try {
      for (const locale of LOCALES) {
        withFakeWindow((win) => {
          (win as unknown as { location: { pathname: string } }).location = { pathname: "/observation" };
          const m = mount(HelpPanel as (p: unknown) => unknown, { contact: { whatsappPhone: null, email: null } }, {
            effects: true,
            intl: locale,
          });
          win.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT, { detail: { topic: "cycle" } }));
          const shown = textOf(m.rerender());
          m.unmount();
          const title = msg(locale, "help.entries.cycle.title");
          assert.ok(shown.includes(title), `${locale}: the article's title (${title}) heads the panel: ${shown}`);
          assert.ok(shown.includes(msg(locale, "help.entries.cycle.long")), `${locale}: the article is in ${locale}`);
          assert.ok(shown.includes(msg(locale, "help.client.panel.back")), `${locale}: the panel's own words too`);
          for (const english of ["Observation cycle", "A cycle is one complete round", "Back to all topics", "Related"]) {
            assert.ok(!shown.includes(english), `${locale}: "${english}" is still English: ${shown}`);
          }
        });
      }
    } finally {
      if (hadDocument) g.document = previousDocument;
      else delete g.document;
    }
  }
});

test("a help tooltip's dot and a page's help button are named in the reader's language", async () => {
  const { HelpDot } = await import("../../apps/web/src/components/help/HelpDot.tsx");
  const { HelpHeadbtn } = await import("../../apps/web/src/components/help/HelpHeadbtn.tsx");
  const { primeHelpEntries } = await import("../../apps/web/src/components/help/useHelpEntries.ts");
  for (const l of LOCALES) primeHelpEntries(l, (loadMessages(l).help as unknown as { entries: Record<string, { title: string; short: string }> }).entries);
  for (const locale of LOCALES) {
    const title = msg(locale, "help.entries.sign_off.title");
    const dot = mount(HelpDot as (p: unknown) => unknown, { k: "sign_off" }, { intl: locale });
    const button = (t: unknown) =>
      (t as { props: { children: Array<{ type: string; props: Record<string, unknown> }> } }).props.children.find(
        (c) => c && c.type === "button",
      )!;
    const dotLabel = button(dot.tree).props["aria-label"] as string;
    assert.ok(dotLabel.includes(title), `${locale}: the ⓘ is named after the topic: ${dotLabel}`);
    assert.doesNotMatch(dotLabel, /What is|Sign-off/);

    const head = mount(HelpHeadbtn as (p: unknown) => unknown, { k: "sign_off" }, { intl: locale });
    const headLabel = (head.tree as { props: Record<string, unknown> }).props["aria-label"] as string;
    assert.ok(headLabel.includes(title), `${locale}: ${headLabel}`);
    assert.doesNotMatch(headLabel, /Help on/);
  }
});

test("the forms read back on a cycle say who submitted them in the reader's language", async () => {
  const { SubmittedForms } = await import(
    "../../apps/web/src/app/(authenticated)/observation/[cycleId]/SubmittedForms.tsx"
  );
  const forms = [
    {
      id: "f1",
      kind: "pre",
      title: "(title)",
      submittedAt: new Date("2026-09-24T10:00:00Z"),
      submitterName: "Tsering Dolma",
      onBehalf: true,
      entries: [{ label: "(label)", value: "fractions" }],
    },
  ];
  for (const locale of LOCALES) {
    request.locale = locale;
    const out = text(await render(h(SubmittedForms, { forms })));
    const by = msg(locale, "observation.submitted.byOnBehalf").replace("{name}", "Tsering Dolma");
    assert.ok(out.includes(by), `${locale}: "${by}" in ${out}`);
    assert.ok(out.includes(msg(locale, "observation.stages.pre.chip")), `${locale}: the stage chip`);
    assert.doesNotMatch(out, /Submitted by|on behalf of/);
    // The date is in the reader's calendar words, not English months.
    assert.doesNotMatch(out, /Sept?|Sep 2026/);
    const none = text(await render(h(SubmittedForms, { forms: [] })));
    assert.ok(none.includes(msg(locale, "observation.submitted.none")), `${locale}: ${none}`);
    assert.doesNotMatch(none, /No forms submitted yet/);
  }
});

// ── Pages and notifications: a committed observation programme ──────────────

test("the observation list and a cycle page are in Hindi and Bhoti", { skip }, async () => {
  const w = await observationWorld("i18nobs");
  try {
    const cyc = await w.cycle({ status: "pre_submitted" });
    await w.c.query(
      `INSERT INTO observation_forms (cycle_id, kind, responses, submitted_by_user_id) VALUES ($1, 'pre', $2, $3)`,
      [cyc.id, JSON.stringify({ lessonPlanSummary: `PLAN-${w.T}` }), w.teacher.id],
    );
    const { default: ListPage } = await import("../../apps/web/src/app/(authenticated)/observation/page.tsx");
    const { default: CyclePage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");

    for (const locale of LOCALES) {
      request.locale = locale;
      signIn(w.teacher);
      const list = text(await render(withAppRouter(await ListPage({ searchParams: Promise.resolve({}) }))));
      assert.ok(list.includes(msg(locale, "observation.list.title")), `${locale}: the list's heading`);
      assert.ok(list.includes(msg(locale, "observation.list.columns.teacher")), `${locale}: the column headings`);
      assert.ok(list.includes(msg(locale, "observation.kindChip.evaluative")), `${locale}: the cycle's kind, as a word`);
      assert.ok(list.includes(msg(locale, "observation.list.stage.pre_submitted")), `${locale}: its stage, as a word`);
      for (const english of ["Observation cycles", "Subject / Topic", "evaluative", "Pre submitted", "Showing 1"]) {
        assert.ok(!list.includes(english), `${locale}: "${english}" is still English on the list`);
      }

      // The observer's view: the rubric form is open to her at this stage.
      signIn(w.observer);
      const page = text(
        await render(
          withAppRouter(
            await CyclePage({
              params: Promise.resolve({ cycleId: cyc.id }),
              searchParams: Promise.resolve({ error: "invalid_form", field: "narrativeComments" }),
            }),
          ),
        ),
      );
      assert.ok(page.includes(`PLAN-${w.T}`), "the teacher's answer is shown as she typed it");
      for (const path of [
        "observation.cycle.stages.pre_submitted",
        "observation.cycle.formsTitle",
        "observation.cycle.submitObserver",
        "observation.fields.lessonPlanSummary.label",
        "observation.fields.narrativeComments.label",
        "observation.cycle.notesTitle",
        "observation.cycle.noNotes",
      ]) {
        assert.ok(page.includes(msg(locale, path)), `${locale}: ${path} ("${msg(locale, path)}") on the cycle page`);
      }
      // The refusal names the question in the reader's language, with the cap.
      assert.ok(page.includes(msg(locale, "observation.fields.narrativeComments.label")));
      for (const english of [
        "Pre & post-observation",
        "Submit observer-form",
        "Lesson plan summary",
        "Observer rubric notes",
        "No notes yet",
        "was blank or longer than",
        "Submitted by",
        "Lesson video",
      ]) {
        assert.ok(!page.includes(english), `${locale}: "${english}" is still English on the cycle page`);
      }
    }
  } finally {
    await w.cleanup();
  }
});

test("the nomination form is in the reader's language", { skip }, async () => {
  const w = await observationWorld("i18nnom");
  try {
    const { default: Nominate } = await import("../../apps/web/src/app/(authenticated)/observation/new/page.tsx");
    for (const locale of LOCALES) {
      request.locale = locale;
      signIn(w.admin);
      const out = text(await render(withAppRouter(await Nominate({ searchParams: Promise.resolve({ error: "invalid", field: "kind" }) }))));
      for (const path of ["observation.nominate.title", "observation.nominate.teacher", "observation.kind.developmental", "observation.nominate.submit"]) {
        assert.ok(out.includes(msg(locale, path)), `${locale}: ${path}`);
      }
      const field = msg(locale, "observation.nominate.fields.kind");
      assert.ok(out.includes(msg(locale, "observation.nominate.errors.invalidField").replace("{field}", field)), `${locale}: the refusal names the field`);
      for (const english of ["Nominate a cycle", "Teacher being observed", "Developmental", "Check: Kind", "Loading many at once"]) {
        assert.ok(!out.includes(english), `${locale}: "${english}" is still English on /observation/new`);
      }
    }
  } finally {
    await w.cleanup();
  }
});

test("a nomination tells each party in their own language, not the nominator's", { skip }, async () => {
  const w = await observationWorld("i18nntf");
  try {
    // The teacher reads Hindi, the observer Bhoti; the mentor never chose.
    await w.c.query(`INSERT INTO user_prefs (user_id, ui_language) VALUES ($1, 'hi'), ($2, 'bo')`, [w.teacher.id, w.observer.id]);
    const { nominateCycleAction } = await import("../../apps/web/src/app/(authenticated)/observation/new/actions.ts");
    await w.grant(w.admin.id);
    request.locale = "en"; // the administrator works in English
    signIn(w.admin);
    const r = await outcome(() =>
      nominateCycleAction(
        form({ teacherId: w.teacherId, observerId: w.observer.id, kind: "baseline", scheduledAt: "2098-03-02T10:00" }),
      ),
    );
    assert.equal(r.kind, "redirect");
    const cycleId = (r as { location: string }).location.split("/").pop()!;
    const rows = (
      await w.c.query(`SELECT user_id, subject, body FROM notifications WHERE entity_id = $1`, [cycleId])
    ).rows as { user_id: string; subject: string; body: string }[];
    const of = (id: string) => rows.find((n) => n.user_id === id)!;
    assert.deepEqual(
      { subject: of(w.teacher.id).subject, body: of(w.teacher.id).body },
      { subject: msg("hi", "observation.notify.assigned.subject"), body: msg("hi", "observation.notify.assigned.body") },
    );
    assert.equal(of(w.observer.id).subject, msg("bo", "observation.notify.assigned.subject"));
    assert.equal(of(w.mentor.id).subject, msg("en", "observation.notify.assigned.subject"), "no saved language: English");
  } finally {
    await w.cleanup();
  }
});
