// The quiz runners and the RTT pages tell every user which answer is picked,
// which filter is on and which page this is -- not by colour alone, and not
// only to a sighted user (F135).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
//   - A picked quiz option was shown by colour and nothing else: the desktop
//     runner inverted the option's ink and paper, the phone runner filled it
//     saffron, and neither changed anything a user who cannot tell the colours
//     apart could see. (aria-pressed already tells a screen reader.)
//   - The phone runner's progress dots put an aria-label on a bare <span>,
//     which has no role that takes a name, so "Current question 2" was never
//     exposed; and the current dot differed from the others by colour only.
//   - The RTT district/zone picker marked the chosen place by hue alone
//     (chip-indigo against the plain chip, the same lightness), and its "All
//     of <district>" chip, a link to the page being shown, did not say it was
//     current. The self-paced units' subject pills and the teach-back queue's
//     tabs showed the filter that is on by fill alone, with no aria-current.
//   - No RTT or quiz page set a title, so every tab, bookmark and history
//     entry read "Goldenmile RTT LMS" and Next's route announcer, which speaks
//     only when document.title changes, said nothing on any navigation.
//   - A timed quiz's countdown was role="timer" with aria-live="polite", so a
//     screen reader read out every second of it over the question; the phone
//     chip was a bare "08:42" with no label.
//   - Each attempt in a quiz's history was two links to the same result, one
//     named only by its timestamp: two tab stops per attempt.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The runners are mounted with ./_ui.ts's `mount` and their REAL click
// handlers are called (and, for the countdown, their real effects run on
// node:test's mocked clock); the pages are rendered for real against Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, mount, hostElements, textOf, renderSync, h, openingTags, attr, elements } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";
import { parseMarkup, walk, type El } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)";
const noop = async () => undefined;
const QUESTIONS = [
  { id: "q1", prompt: "Which is a vowel?", options: ["Apple", "Bat", "Cat", "Dog"] },
  { id: "q2", prompt: "Which is a consonant?", options: ["Egg", "Fig", "Ice", "Oak"] },
];

// ── the picked answer, not by colour alone ───────────────────────────────────

type AnyEl = { type: unknown; props: Record<string, unknown> };

/** Properties that carry colour, and the colour tokens inside their values. */
const COLOUR_PROPS = /^(background|backgroundColor|color|border|borderColor|border(Top|Right|Bottom|Left)(Color)?|outline|outlineColor|boxShadow|fill|stroke|textDecorationColor)$/;
const COLOUR = /var\(--[\w-]+\)|#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|\btransparent\b|\bcurrentColor\b/g;

/**
 * An element as it looks with every colour taken out: its tag, its styles with
 * the colours removed from their values (`1px solid var(--ink)` is `1px solid`,
 * a background is nothing), its other presentational attributes, and its
 * children. Two states with the same shape differ only in colour.
 */
function shape(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(shape).join("");
  const el = node as AnyEl;
  if (!el.props) return "";
  // `mount` leaves child components unexpanded; a stateless one (the check
  // mark) is rendered here, so what is compared is what it draws.
  if (typeof el.type === "function") return shape((el.type as (p: unknown) => unknown)(el.props));
  const style = Object.entries((el.props.style ?? {}) as Record<string, unknown>)
    .map(([k, v]) => [k, COLOUR_PROPS.test(k) ? String(v).replace(COLOUR, "").trim() : String(v)] as const)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .sort()
    .join(";");
  // State for assistive technology is not a visual cue; handlers and test ids
  // are not visible at all.
  const attrs = Object.entries(el.props)
    .filter(([k, v]) => !["children", "style", "aria-pressed"].includes(k) && !/^on[A-Z]/.test(k) && !k.startsWith("data-") && typeof v !== "function")
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join(" ");
  return `<${String(el.type)} ${attrs} {${style}}>${shape(el.props.children)}</${String(el.type)}>`;
}

test("a picked quiz option differs from an unpicked one in more than colour (desktop and mobile)", async () => {
  const { QuizRunner } = await import("../../apps/web/src/components/quiz/QuizRunner.tsx");
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  for (const [name, Runner] of [["QuizRunner", QuizRunner], ["MobileQuizRunner", MobileQuizRunner]] as const) {
    const m = mount(Runner as (p: unknown) => unknown, { slug: "s", title: "T", questions: QUESTIONS, submitAction: noop });
    const options = () => hostElements(m.tree).filter((el) => el.type === "button" && /^[A-D](Apple|Bat|Cat|Dog)$/.test(textOf(el)));
    assert.equal(options().length, 4, `${name}: four options`);
    const before = options().map(shape);
    (options()[1]!.props.onClick as () => void)();
    m.rerender();
    const afterPick = options().map(shape);
    assert.equal(options()[1]!.props["aria-pressed"], true, `${name}: B is picked`);
    assert.notEqual(afterPick[1], before[1], `${name}: with its colours taken away, the picked option must still look picked`);
    for (const i of [0, 2, 3]) assert.equal(afterPick[i], before[i], `${name}: option ${i} is not picked and looks as it did`);
    // The cue moves with the answer.
    (options()[3]!.props.onClick as () => void)();
    m.rerender();
    const afterChange = options().map(shape);
    assert.equal(afterChange[1], before[1], `${name}: B, no longer picked, looks unpicked again`);
    assert.notEqual(afterChange[3], before[3], `${name}: D now looks picked`);
    m.unmount();
  }
});

test("the phone runner's progress dots expose their labels, and the current one is marked by more than colour", async () => {
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  const html = renderSync(h(MobileQuizRunner, { slug: "s", title: "T", questions: QUESTIONS, submitAction: noop }));
  const dots = openingTags(html, "span").filter((t) => /mobile-quiz-dot-\d/.test(attr(t, "data-testid") ?? ""));
  assert.equal(dots.length, 2);
  for (const d of dots) {
    // aria-label is not allowed on a generic <span> (ARIA 1.2) and assistive
    // technology does not read it there; role="img" is a role that takes one.
    assert.equal(attr(d, "role"), "img", `${attr(d, "aria-label")}: a role its label names`);
  }
  assert.deepEqual(
    dots.map((d) => [attr(d, "aria-label"), attr(d, "aria-current")]),
    [
      ["Current question 1", "step"],
      ["Unanswered question 2", null],
    ],
  );
  // The current dot's size differs, not only its fill.
  const height = (t: string) => attr(t, "style")?.match(/(?:^|;)height:([^;]+)/)?.[1];
  assert.notEqual(height(dots[0]!), height(dots[1]!), "the current dot is taller than the others");
});

// ── the countdown, heard at its thresholds and not every second ──────────────

/** A region a screen reader speaks on change: an explicit aria-live, or a role that is one. */
const isLive = (el: AnyEl) =>
  ["polite", "assertive"].includes(String(el.props["aria-live"])) || ["status", "alert", "log"].includes(String(el.props.role));

test("the quiz countdown is not read out every second: the timer is not a live region, one polite region speaks at 5 minutes, 1 minute and time up, and the phone's chip says what it counts", async (t) => {
  const { QuizRunner } = await import("../../apps/web/src/components/quiz/QuizRunner.tsx");
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  for (const [name, Runner] of [["QuizRunner", QuizRunner], ["MobileQuizRunner", MobileQuizRunner]] as const) {
    const LIMIT = 400;
    let submits = 0;
    const m = mount(
      Runner as (p: unknown) => unknown,
      { slug: "s", title: "T", questions: QUESTIONS, timeLimitSeconds: LIMIT, submitAction: async () => void submits++ },
      { effects: true },
    );
    try {
      const timer = () => {
        const found = hostElements(m.tree).filter((el) => el.props.role === "timer");
        assert.equal(found.length, 1, `${name}: one timer`);
        return found[0]!;
      };
      // role="timer" is aria-live="off" by definition; the runners set
      // aria-live="polite" on it, so the value, which changes every second,
      // was queued for speech every second over the question being read.
      assert.ok([undefined, "off"].includes(timer().props["aria-live"] as string | undefined), `${name}: the timer is not a live region (aria-live=${String(timer().props["aria-live"])})`);
      // Its label is part of it: the phone's chip was a bare "06:40".
      assert.match(textOf(timer()), /^Time remaining\s*06:40$/, `${name}: the timer says what it counts`);
      const regions = () => hostElements(m.tree).filter(isLive);
      for (const r of regions()) assert.doesNotMatch(textOf(r), /\d\d:\d\d/, `${name}: no live region holds the ticking value`);
      assert.equal(regions().length, 1, `${name}: one live region for the countdown`);
      assert.equal(textOf(regions()[0]!), "", `${name}: silent at the start`);

      // Every second to 00:00: what the region says, and when it changes.
      const said: Array<[number, string]> = [];
      let last = "";
      for (let s = 1; s <= LIMIT; s++) {
        t.mock.timers.tick(1000);
        m.rerender();
        const now = regions().map(textOf).join("|");
        if (now !== last) said.push([LIMIT - s, now]);
        last = now;
      }
      assert.deepEqual(
        said,
        [
          [300, "5 minutes remaining."],
          [60, "1 minute remaining."],
          [0, "Time is up. Your answers are being submitted."],
        ],
        `${name}: spoken at the thresholds only`,
      );
      assert.equal(submits, 1, `${name}: auto-submitted once`);
    } finally {
      m.unmount();
    }
  }

  // A limit shorter than a threshold never announces it: an attempt that
  // opens with 3 minutes left is not told "5 minutes remaining".
  const m = mount(
    QuizRunner as (p: unknown) => unknown,
    { slug: "s", title: "T", questions: QUESTIONS, timeLimitSeconds: 180, submitAction: noop },
    { effects: true },
  );
  try {
    const said = new Set<string>();
    for (let s = 1; s <= 180; s++) {
      t.mock.timers.tick(1000);
      m.rerender();
      said.add(hostElements(m.tree).filter(isLive).map(textOf).join("|"));
    }
    assert.deepEqual([...said], ["", "1 minute remaining.", "Time is up. Your answers are being submitted."]);
  } finally {
    m.unmount();
  }
});

// ── the filter that is on ────────────────────────────────────────────────────

const P = <T,>(v: T) => Promise.resolve(v);

async function page(user: TestUser, run: () => Promise<unknown>): Promise<string> {
  signIn(user);
  return render(withAppRouter(await run()));
}

/** The <a> elements inside the element that `pick` selects. */
function linksIn(html: string, pick: (el: El) => boolean): El[] {
  const box = [...walk(parseMarkup(html))].find(pick);
  assert.ok(box, "found the filter group");
  return [...walk(box)].filter((el) => el.tag === "a");
}

test("the RTT place picker says which place is shown (aria-current), and not by a hue alone", { skip }, async () => {
  const w = await rttWorld("a11yrttp");
  try {
    // /rtt with a district chosen: its chip and "All of <district>" both link
    // to the page shown.
    const { default: Index } = await import(`${APP}/rtt/page.tsx`);
    const here = `/rtt?district=${w.districtId}`;
    const rtt = await page(w.admin, () => Index({ searchParams: P({ district: w.districtId }) }));
    const place = linksIn(rtt, (el) => el.tag === "nav" && el.attrs["aria-label"] === "District and zone");
    const current = place.filter((a) => a.attrs.href === here);
    assert.equal(current.length, 2, "the district's chip and its 'All of' chip");
    for (const a of place) {
      assert.equal(a.attrs["aria-current"] === "page", a.attrs.href === here, `chip ${a.attrs.href} says whether it is the page shown`);
    }
    // Not by hue alone: chip-indigo and the plain chip are the same lightness.
    const on = place.filter((a) => /chip-indigo/.test(a.attrs.class ?? ""));
    const off = place.filter((a) => !/chip-indigo/.test(a.attrs.class ?? ""));
    assert.ok(on.length > 0 && off.length > 0);
    for (const a of on) assert.match(a.attrs.style ?? "", /font-weight:\s*600/, `chosen chip ${a.attrs.href} is bold`);
    for (const a of off) assert.doesNotMatch(a.attrs.style ?? "", /font-weight/, `chip ${a.attrs.href} is not`);
  } finally {
    await w.cleanup();
  }
});

test("the self-paced units' subject pills say which one is on (aria-current)", { skip }, async () => {
  const w = await rttWorld("a11yrtta");
  try {
    await w.subject();
    // The "All" pill, then a subject's.
    const { default: Async } = await import(`${APP}/rtt/online/asynchronous/page.tsx`);
    const pills = (html: string) => linksIn(html, (el) => el.tag === "nav" && el.attrs["aria-label"] === "Filter by RTT subject");
    const all = pills(await page(w.teacher, () => Async({ searchParams: P({}) })));
    assert.ok(all.length >= 2, "the All pill and the teacher's subject");
    assert.deepEqual(
      all.map((a) => a.attrs["aria-current"] ?? null),
      all.map((a) => (a.attrs.href === "/rtt/online/asynchronous" ? "page" : null)),
      "only All is current",
    );
    const subjectHref = all.find((a) => a.attrs.href !== "/rtt/online/asynchronous")!.attrs.href!;
    const subjectId = decodeURIComponent(subjectHref.split("subject=")[1]!);
    const bySubject = pills(await page(w.teacher, () => Async({ searchParams: P({ subject: subjectId }) })));
    assert.deepEqual(
      bySubject.map((a) => a.attrs["aria-current"] ?? null),
      bySubject.map((a) => (a.attrs.href === subjectHref ? "page" : null)),
      "only the chosen subject is current",
    );
  } finally {
    await w.cleanup();
  }
});

test("the teach-back queue's tabs say which one is on (aria-current)", { skip }, async () => {
  const w = await rttWorld("a11yrttq");
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const fileId = await one(
    `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id)
     VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2) RETURNING id`,
    [`test/${w.T}/original.mp4`, w.teacher.id],
  );
  try {
    await w.c.query(
      `INSERT INTO video_submissions (file_id, source, status, context_type, submitted_by_user_id, hls_master_key, verified_at)
       VALUES ($1, 'direct', 'ready', 'teach_back', $2, 'hls/test/index.m3u8', now())`,
      [fileId, w.teacher.id],
    );
    const { default: Queue } = await import(`${APP}/rtt/teach-back/page.tsx`);
    // The tabs are the links to a bare filter: not the header's shortcut (an
    // absolute URL), a row (?id=) or the pager (?page=).
    const tabs = (html: string) =>
      [...walk(parseMarkup(html))].filter(
        (el) => el.tag === "a" && (el.attrs.href === "/rtt/teach-back" || /^\?status=[a-z_]+$/.test(el.attrs.href ?? "")),
      );
    for (const [sp, active] of [
      [{}, "/rtt/teach-back"],
      [{ status: "review_pending" }, "?status=review_pending"],
      [{ status: "reviewed" }, "?status=reviewed"],
    ] as const) {
      const t = tabs(await page(w.mentor, () => Queue({ searchParams: P(sp) })));
      assert.equal(t.length, 3);
      assert.deepEqual(
        t.map((a) => a.attrs["aria-current"] ?? null),
        t.map((a) => (a.attrs.href === active ? "page" : null)),
        `on ${active} only that tab is current`,
      );
    }
  } finally {
    await w.c.query(`DELETE FROM video_submissions WHERE file_id = $1`, [fileId]);
    await w.c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await w.cleanup();
  }
});

// ── one link per attempt ─────────────────────────────────────────────────────

test("each attempt in a quiz's history is one link to a keyboard and a screen reader, named by its date and what it opens", { skip }, async () => {
  const w = await rttWorld("a11yqhist");
  try {
    const subjectId = await w.subject();
    const quiz = await w.quiz(subjectId, { title: `History ${w.T}`, maxAttempts: 3 });
    const attempts = [await w.submission(quiz.id, w.teacher.id, 100, true), await w.submission(quiz.id, w.teacher.id, 50, false)];
    const { default: History } = await import(`${APP}/quizzes/[slug]/history/page.tsx`);
    const html = await page(w.teacher, () => History({ params: P({ slug: quiz.slug }), searchParams: P({}) }));
    const links = elements(html, "a");
    for (const id of attempts) {
      const toResult = links.filter((a) => attr(a.open, "href") === `/quizzes/${quiz.slug}/result/${id}`);
      assert.ok(toResult.length >= 1, "the attempt links to its result");
      // The row has two links to the same result -- the date at its left edge,
      // which a phone shows when the table has scrolled, and "View result" --
      // and both were tab stops, one named only by a timestamp.
      const reachable = toResult.filter((a) => attr(a.open, "tabindex") !== "-1" && attr(a.open, "aria-hidden") !== "true");
      assert.equal(reachable.length, 1, `attempt ${id}: one tab stop and one link for a screen reader, not ${reachable.length}`);
      // The other is for a pointer only: out of the tab order AND hidden, as
      // a hidden element that can still take focus is announced as nothing.
      for (const a of toResult.filter((x) => !reachable.includes(x))) {
        assert.equal(attr(a.open, "tabindex"), "-1", `${a.text}: not a tab stop`);
        assert.equal(attr(a.open, "aria-hidden"), "true", `${a.text}: hidden from a screen reader`);
      }
      const link = reachable[0]!;
      const name = attr(link.open, "aria-label") ?? link.text;
      assert.match(name, /view result/i, `"${name}" says what it opens`);
      assert.match(name, /\d{4}/, `"${name}" says which attempt`);
      // Label in name (WCAG 2.5.3): a speech user says what they see.
      assert.ok(name.includes(link.text.trim()), `"${name}" contains the visible "${link.text.trim()}"`);
    }
  } finally {
    await w.c.query(`DELETE FROM quiz_attempts WHERE user_id = $1`, [w.teacher.id]);
    await w.cleanup();
  }
});

// ── the page's own name ──────────────────────────────────────────────────────

// { skip }: importing a page imports @gml/db, which refuses to load without
// DATABASE_URL -- although nothing here queries it.
test("every RTT and quiz page has its own title", { skip }, async () => {
  const { metadata: root } = (await import("../../apps/web/src/app/layout.tsx")) as {
    metadata: { title: { template: string; default: string } };
  };
  const routes = [
    "rtt/page.tsx",
    "rtt/subject/[id]/page.tsx",
    "rtt/progress/page.tsx",
    "rtt/online/synchronous/page.tsx",
    "rtt/online/asynchronous/page.tsx",
    "rtt/teach-back/page.tsx",
    "quizzes/[slug]/page.tsx",
    "quizzes/[slug]/history/page.tsx",
    "quizzes/[slug]/result/[submissionId]/page.tsx",
  ];
  const seen = new Map<string, string>();
  for (const r of routes) {
    const mod = (await import(`${APP}/${r}`)) as { metadata?: { title?: unknown } };
    const title = mod.metadata?.title;
    assert.equal(typeof title, "string", `${r} exports a metadata title`);
    const t = (title as string).trim();
    assert.ok(t.length > 0 && t !== root.title.default, `${r}: "${t}" names the page`);
    assert.ok(!seen.has(t), `${r} and ${seen.get(t)} share the title "${t}"`);
    seen.set(t, r);
  }
});
