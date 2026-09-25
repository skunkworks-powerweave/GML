// The mentorship, forms and inbox pages lay out at PHONE width -- executed on
// their real markup (F11).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The phone shell renders the same page JSX as the desktop shell, and the
// pairing page -- the one "most meetings are logged from", on a phone -- set
// its columns as inline styles that hold at every width: the body was
// gridTemplateColumns "1.5fr 1fr", the quarter strip "repeat(4, 1fr)" and the
// add-commitment row "1fr 90px 70px auto". At 375 px the page was ~650 px
// wide: Q3 and Q4 and the commitment inputs sat off the right edge, and
// Chrome widened the layout viewport, which put the fixed bottom tab bar --
// the only navigation on a phone -- off screen. The pairings list tiled cards
// at no less than 320 px, wider than a phone's content box.
//
// The phone form's star rating was five fixed 56 px stars with 8 px gaps --
// 312 px in a 228 px row on a 360 px phone. Without wrapping (as it first
// was) the row was as wide as its stars and the runner clipped the fourth
// and fifth off its right edge; allowed to wrap, it broke into "3 stars, then
// 2" (4 + 1 at 412 px), which hides the length and order of a 1-5 scale. The
// stars have to share one line: each shrinks, down to a floor that five of
// them fit in and that is still the runner's 44 px touch target.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Each REAL page is rendered as a phone user (gml-device=mobile) against
// Postgres, and ./_phone-layout.ts resolves every element's layout at 360 px
// from its inline style, globals.css and the app's own Tailwind build (that
// resolver is checked against known markup in ui-phone-layout.test.ts). The
// star row and the add-commitment row are then sized from those resolved
// styles, the way a flex row breaks lines and shares its width.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, withAppRouter, request, renderSync, h } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import {
  phoneLayoutIssues,
  templateAt,
  parseMarkup,
  resolverFor,
  walk,
  PHONE_WIDTH,
  type El,
  type Resolver,
} from "./_phone-layout.js";

const skip = needsDatabase();
after(closeAppPool);

const APP = "../../apps/web/src/app/(authenticated)";

/** Render a page as `who` on a phone (or on a desktop), failing loudly on a redirect or 404. */
async function asDevice(who: Person, device: "mobile" | "desktop", run: () => Promise<unknown>): Promise<string> {
  signIn(who);
  request.cookies = { "gml-device": device };
  try {
    const r = await outcome(run);
    assert.equal(r.kind, "value", describe(r));
    return await render(withAppRouter((r as { value: unknown }).value));
  } finally {
    request.cookies = {};
  }
}
const asPhone = (who: Person, run: () => Promise<unknown>) => asDevice(who, "mobile", run);

function noIssues(issues: string[], where: string) {
  assert.deepEqual(issues, [], `${where} at ${PHONE_WIDTH}px:\n  ${issues.join("\n  ")}`);
}

/** Track count of a resolved template ("minmax(0,1.5fr) minmax(0,1fr)" -> 2). */
function columns(template: string): number {
  const m = template.match(/^repeat\((\d+),/);
  if (m) return Number(m[1]);
  return template.split(/\s+(?![^(]*\))/).filter(Boolean).length;
}

async function withWorld(prefix: string, body: (w: World) => Promise<void>) {
  const w = await buildWorld(prefix);
  try {
    for (const p of [w.admin, w.mentor, w.teacherA, w.teacherB]) await w.grant(p.id);
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

// ── sizing a row from its resolved styles ────────────────────────────────────

/**
 * MobileShell's <main> pads 16 px each side. It is in the layout, not in a
 * page's markup, so it is the one part of the phone counted here by hand
 * (./_phone-layout.ts's PHONE_CONTENT counts it the same way).
 */
const SHELL_PADDING = 16;

function tagOf(el: El): string {
  return `<${el.tag}${el.attrs.style ? ` style="${el.attrs.style}"` : ""}>`;
}

/** A length in px. A value this cannot read fails the check rather than passing it. */
function px(value: string, where: El): number {
  const v = value.trim();
  if (/^0(%|px)?$/.test(v)) return 0;
  const m = v.match(/^([\d.]+)(px|rem)$/);
  assert.ok(m, `cannot size "${value}" on ${tagOf(where)}`);
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
}

/** Left + right of a 1-4 value box shorthand ("16px 16px 24px" -> 32). */
function leftRight(value: string, read: (v: string) => number): number {
  const t = value.trim().split(/\s+(?![^(]*\))/);
  const right = t[1] ?? t[0]!;
  return read(t[3] ?? right) + read(right);
}

/** A border shorthand's width ("1px solid var(--line)" -> 1); no style, no border. */
function borderWidth(value: string, where: El): number {
  const t = value.trim().split(/\s+(?![^(]*\))/);
  if (!t.some((x) => /^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(x))) return 0;
  const w = t.find((x) => /^[\d.]+(px|rem)$|^0$|^(thin|medium|thick)$/.test(x)) ?? "medium";
  return ({ thin: 1, medium: 3, thick: 5 } as Record<string, number>)[w] ?? px(w, where);
}

/**
 * The width of `el`'s content box on a PHONE_WIDTH phone: the phone less the
 * shell's padding and, from the outside in, each element's horizontal margin,
 * border and padding (box-sizing is border-box app-wide), capped by a px
 * max-width. Every element on the way must fill its parent's width: one that
 * sits beside others in a grid or a flex row cannot be sized this way, and
 * fails the check.
 */
function contentWidth(el: El, get: Resolver): number {
  const chain: El[] = [];
  for (let n: El | null = el; n && n.tag !== "#root"; n = n.parent) chain.unshift(n);
  let width = PHONE_WIDTH - 2 * SHELL_PADDING;
  for (const n of chain) {
    const parent = n.parent!;
    const pd = get(parent, "display");
    if (pd === "grid" || pd === "inline-grid") {
      const tpl = get(parent, "grid-template-columns") ?? "none";
      assert.ok(tpl === "none" || columns(tpl) === 1, `${tagOf(n)} is one of the columns (${tpl}) of ${tagOf(parent)}`);
    }
    if ((pd === "flex" || pd === "inline-flex") && !/column/.test(get(parent, "flex-direction") ?? "")) {
      assert.equal(parent.children.length, 1, `${tagOf(n)} shares a flex row with others`);
    }
    const margin = get(n, "margin");
    let outer = width - (margin ? leftRight(margin, (v) => (v === "auto" ? 0 : px(v, n))) : 0);
    const max = get(n, "max-width");
    if (max && /^[\d.]+(px|rem)$/.test(max)) outer = Math.min(outer, px(max, n));
    const padding = get(n, "padding");
    const border = get(n, "border");
    width =
      outer -
      (padding ? leftRight(padding, (v) => px(v, n)) : 0) -
      (border ? 2 * borderWidth(border, n) : 0);
  }
  return width;
}

/** A flex item's grow, shrink and basis, from `flex` and its longhands. */
function flexOf(el: El, get: Resolver): { grow: number; shrink: number; basis: string } {
  let grow = 0;
  let shrink = 1;
  let basis = "auto";
  const f = get(el, "flex");
  if (f === "none") [grow, shrink] = [0, 0];
  else if (f === "auto") [grow, shrink] = [1, 1];
  else if (f) {
    const t = f.trim().split(/\s+/);
    const num = (x: string | undefined) => x !== undefined && /^[\d.]+$/.test(x);
    grow = num(t[0]) ? Number(t[0]) : 1;
    shrink = num(t[1]) ? Number(t[1]) : 1;
    basis = t.find((x, i) => !(num(x) && i < 2)) ?? "0";
  }
  const g = get(el, "flex-grow");
  const s = get(el, "flex-shrink");
  const b = get(el, "flex-basis");
  return { grow: g !== undefined ? Number(g) : grow, shrink: s !== undefined ? Number(s) : shrink, basis: b ?? basis };
}

/**
 * The width a flex item claims when its row decides where to break lines:
 * its flex basis (its width, when the basis is auto) held between min-width
 * and max-width. With min-width auto a basis below the item's width would
 * leave its content deciding, which this cannot know -- that fails.
 */
function lineBreakWidth(item: El, get: Resolver): number {
  const { basis } = flexOf(item, get);
  const b = basis === "auto" || basis === "content" ? get(item, "width") : basis;
  assert.ok(b !== undefined && b !== "auto", `${tagOf(item)} is as wide as its content`);
  let w = px(b, item);
  const max = get(item, "max-width");
  if (max !== undefined && max !== "none") w = Math.min(w, px(max, item));
  const min = get(item, "min-width");
  if (min === undefined || min === "auto") {
    assert.ok(basis === "auto" || basis === "content", `${tagOf(item)}: flex-basis ${basis} with min-width auto is as wide as its content`);
  } else w = Math.max(w, px(min, item));
  return w;
}

/**
 * Why the add-commitment row's Add button would not keep its label's width,
 * or null. It must not be handed what the other controls leave -- a
 * minmax(0, 1fr) column, or a flex item allowed below its content -- and
 * something beside it must give way instead.
 */
function addButtonProblem(root: El, get: Resolver): string | null {
  const form = [...walk(root)].find((e) => e.tag === "form" && [...walk(e)].some((c) => c.attrs.name === "text"));
  assert.ok(form, "the add-commitment form");
  const button = [...walk(form)].find((e) => e.tag === "button" && e.attrs.type === "submit");
  assert.ok(button, "its Add button");
  const row = button.parent!;
  // A hidden input is display:none; it takes no place in the row.
  const items = row.children.filter((c) => !(c.tag === "input" && c.attrs.type === "hidden"));
  const display = get(row, "display");
  if (display === "grid" || display === "inline-grid") {
    const tpl = get(row, "grid-template-columns") ?? "none";
    const tracks = tpl === "none" ? ["auto"] : tpl.split(/\s+(?![^(]*\))/);
    // Auto-placement, where an item spanning 1 / -1 has a row of its own.
    let col = 0;
    let at = 0;
    for (const it of items) {
      if ((get(it, "grid-column") ?? "").replace(/\s/g, "") === "1/-1") {
        col = 0;
        continue;
      }
      at = col;
      if (it === button) break;
      col = (col + 1) % tracks.length;
    }
    const track = tracks[at]!;
    return /^(auto|max-content|min-content|fit-content\(.*\))$/.test(track)
      ? null
      : `the Add button's column is ${track} of (${tpl}): it gets what the other controls leave`;
  }
  if ((display === "flex" || display === "inline-flex") && !/column/.test(get(row, "flex-direction") ?? "")) {
    const f = flexOf(button, get);
    const floor = get(button, "min-width");
    if (f.shrink > 0 && floor !== undefined && floor !== "auto") {
      return `the Add button shrinks (flex-shrink ${f.shrink}) down to min-width ${floor}, below its label`;
    }
    const givesWay = items.some((c) => {
      if (c === button) return false;
      const cf = flexOf(c, get);
      return cf.grow > 0 && cf.shrink > 0 && /^0(px)?$/.test(get(c, "min-width") ?? "auto");
    });
    return givesWay ? null : "nothing beside the Add button grows and shrinks (flex-grow and min-width: 0) to give way";
  }
  return `the Add button is not in a row: ${tagOf(row)}`;
}

/**
 * Why the add-commitment row's min-content width could widen the page, or
 * null. That width counts each input at its default width -- about 20
 * characters, 138 px for the due box in Chrome -- whatever share of the row
 * it is then given, and a grid column with an auto minimum (an implicit one,
 * `auto`, a bare `1fr`) grows to the min-content of an item that does not
 * shrink itself: at 360 px that made the page 376 px wide. A grid of
 * minmax(0, ...) and fixed columns does not pass its content's width on
 * (under a min-content constraint its fr columns are 0), so the row must be
 * one, or the first grid above it must hold it in one, or an element on the
 * way must have min-width 0 or clip its overflow. Blocks pass the width on.
 */
function grownByContent(root: El, get: Resolver): string | null {
  const text = [...walk(root)].find((e) => e.attrs.name === "text");
  const button = [...walk(text!.parent!)].find((e) => e.tag === "button" && e.attrs.type === "submit")!;
  const shrinks = (el: El) =>
    /^0(px)?$/.test(get(el, "min-width") ?? "auto") ||
    /^(hidden|auto|scroll|clip)$/.test(get(el, "overflow-x") ?? get(el, "overflow") ?? "visible");
  const isGrid = (el: El) => /^(inline-)?grid$/.test(get(el, "display") ?? "");
  const holds = (grid: El) => {
    const tpl = get(grid, "grid-template-columns") ?? "none";
    const tracks = tpl === "none" ? ["auto"] : tpl.split(/\s+(?![^(]*\))/);
    return tracks.every((t) => /^minmax\(\s*0(px)?\s*,/.test(t) || /^[\d.]+(px|rem)$/.test(t));
  };
  if (isGrid(button.parent!) && holds(button.parent!)) return null;
  for (let item: El = button.parent!; item.parent && item.parent.tag !== "#root"; item = item.parent) {
    if (shrinks(item)) return null;
    const parent = item.parent;
    const pd = get(parent, "display");
    if (isGrid(parent)) {
      if (holds(parent)) return null;
      return `the add-commitment row's content widens a grid column with an auto minimum (${get(parent, "grid-template-columns") ?? "none"}): ${tagOf(parent)}`;
    }
    if ((pd === "flex" || pd === "inline-flex") && !/column/.test(get(parent, "flex-direction") ?? "")) {
      return `the add-commitment row's content widens a flex item with min-width auto: ${tagOf(item)}`;
    }
  }
  return null;
}

// ── /mentorship/[pairingId] ──────────────────────────────────────────────────

test("a pairing page fits a phone: the quarters, the body and the commitment row stack; a desktop keeps its columns", { skip }, async () => {
  await withWorld("phonepair", async (w) => {
    // Content in every part of the page: a commitment whose text is one long
    // unbroken word (a pasted link), a meeting with notes, and the open
    // "Log meeting" form.
    const long = `https://example.test/${"x".repeat(80)}`;
    await w.q(`UPDATE mentor_pairings SET commitments = $2::jsonb, concept_note = 'Build a reading corner' WHERE id = $1`, [
      w.pairingA,
      JSON.stringify([{ id: "c1", text: long, who: "mentee", due: "Wk 8", done: false }]),
    ]);
    await w.q(`INSERT INTO mentor_meetings (pairing_id, scheduled_at, duration_min, notes) VALUES ($1, now() + interval '2 days', 40, $2)`, [
      w.pairingA,
      `Discussed ${long}`,
    ]);

    const { default: PairingPage } = await import(`${APP}/mentorship/[pairingId]/page.tsx`);
    const page = (sp: Record<string, string>) => () =>
      PairingPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve(sp) });

    const failures: string[] = [];
    for (const [who, sp, label] of [
      [w.mentor, { logMeeting: "1" }, "mentor, logging a meeting"],
      [w.teacherA, {}, "mentee"],
      [w.admin, {}, "administrator"],
    ] as const) {
      const html = await asPhone(who, page(sp));
      assert.match(html, /name="text"/, `${label}: the add-commitment row is on the page`);
      if (who === w.mentor) assert.match(html, /name="scheduledAt"/, "the Log meeting form is open");
      for (const issue of await phoneLayoutIssues(html)) failures.push(`${label}: ${issue}`);
      // The Add button keeps its label's width, and the due box gives way. In
      // a "90px 70px minmax(0, 1fr)" row it had what was left: 34 px at 360 px
      // for a 46 px button, the label up against its right edge.
      // And the row's inputs, at their default widths, do not widen the page.
      const root = parseMarkup(html);
      const get = await resolverFor(root, PHONE_WIDTH);
      for (const problem of [addButtonProblem(root, get), grownByContent(root, get)]) {
        if (problem) failures.push(`${label}: ${problem}`);
      }
    }
    noIssues(failures, "/mentorship/[pairingId]");

    // The desktop layout is unchanged: meetings beside feedback, four quarters.
    const desktop = await asDevice(w.mentor, "desktop", page({}));
    const body = await templateAt(desktop, 1280, (e) => (e.attrs.class ?? "").split(" ").includes("page-body"));
    assert.equal(body.length, 1);
    assert.equal(columns(body[0]!), 2, `two columns on a desktop: ${body[0]}`);
    const strip = await templateAt(desktop, 1280, (e) => e.attrs["data-testid"] === "quarter-strip");
    assert.equal(strip.length, 1, "the quarter strip is marked");
    assert.equal(columns(strip[0]!), 4, `four quarters side by side on a desktop: ${strip[0]}`);

    // The header row may wrap (a phone needs it to), but on a desktop the
    // action buttons stay beside the title: the title block breaks lines at a
    // fixed basis and shrinks, so a long "Mentor <-> Teacher" wraps inside it
    // before the buttons drop below it. With a basis of auto it claimed its
    // whole name's width, and the buttons went to a line of their own.
    const droot = parseMarkup(desktop);
    const dget = await resolverFor(droot, 1280);
    const h1 = [...walk(droot)].filter((e) => e.tag === "h1");
    assert.equal(h1.length, 1, "the pairing's name");
    const titleBlock = h1[0]!.parent!;
    assert.equal(dget(titleBlock.parent!, "flex-wrap"), "wrap", "the header row wraps");
    const tf = flexOf(titleBlock, dget);
    assert.ok(
      tf.shrink > 0 && /^[\d.]+(px|rem)$/.test(tf.basis) && /^0(px)?$/.test(dget(titleBlock, "min-width") ?? "auto"),
      `the title block breaks lines at a fixed basis and shrinks (flex ${tf.grow} ${tf.shrink} ${tf.basis}, min-width ${dget(titleBlock, "min-width") ?? "auto"}): ${tagOf(titleBlock)}`,
    );
  });
});

// ── /mentorship and the responses record ─────────────────────────────────────

test("the pairings list and a pairing's responses fit a phone", { skip }, async () => {
  await withWorld("phonelist", async (w) => {
    const form = await w.form("baseline", "mentor", { title: `Baseline ${w.T}`, fields: [{ name: "q1", label: "Q1", kind: "textarea" }] });
    await w.q(
      `INSERT INTO feedback_responses (form_id, respondent_user_id, pairing_id, responses) VALUES ($1, $2, $3, $4::jsonb)`,
      [form.id, w.mentor.id, w.pairingA, JSON.stringify({ q1: `See https://example.test/${"y".repeat(80)}` })],
    );
    const { default: ListPage } = await import(`${APP}/mentorship/page.tsx`);
    const { default: ResponsesPage } = await import(`${APP}/mentorship/[pairingId]/responses/page.tsx`);
    for (const who of [w.mentor, w.admin]) {
      const list = await asPhone(who, () => ListPage({ searchParams: Promise.resolve({}) }));
      assert.match(list, new RegExp(`href="/mentorship/${w.pairingA}"`), `${who.role}: the pairing is listed`);
      noIssues(await phoneLayoutIssues(list), `/mentorship as ${who.role}`);
    }
    const responses = await asPhone(w.mentor, () => ResponsesPage({ params: Promise.resolve({ pairingId: w.pairingA }) }));
    assert.match(responses, /data-testid="response"/, "the response is shown");
    noIssues(await phoneLayoutIssues(responses), "/mentorship/[pairingId]/responses");
  });
});

// ── /forms, a form on a phone, and its thank-you page ────────────────────────

test("the forms catalogue, the phone form runner and the thank-you page fit a phone", { skip }, async () => {
  await withWorld("phoneform", async (w) => {
    // The rating first, so the runner's first screen is the star row.
    const form = await w.form("baseline", "mentor", {
      title: `Baseline ${w.T}`,
      fields: [
        { name: "overall", label: "Overall", kind: "rating", required: true },
        { name: "notes", label: "Notes", kind: "textarea" },
      ],
    });
    const { default: FormsPage } = await import(`${APP}/forms/page.tsx`);
    // The mentor has two mentees, so each form row lists one link per pairing.
    const catalogue = await asPhone(w.mentor, () => FormsPage({ searchParams: Promise.resolve({}) }));
    assert.match(catalogue, new RegExp(`pairingId=${w.pairingB}`), "one link per pairing");
    noIssues(await phoneLayoutIssues(catalogue), "/forms as mentor");
    noIssues(await phoneLayoutIssues(await asPhone(w.admin, () => FormsPage({ searchParams: Promise.resolve({}) }))), "/forms as admin");

    const { default: RunnerPage } = await import(`${APP}/forms/[slug]/page.tsx`);
    const runner = await asPhone(w.mentor, () =>
      RunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
    );
    assert.match(runner, /data-testid="mobile-rating"/, "the phone runner's first screen is the star row");
    noIssues(await phoneLayoutIssues(runner), "/forms/[slug]");

    const { default: ThanksPage } = await import(`${APP}/forms/[slug]/thanks/page.tsx`);
    const thanks = await asPhone(w.mentor, () =>
      ThanksPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
    );
    noIssues(await phoneLayoutIssues(thanks), "/forms/[slug]/thanks");
    // Two buttons, ~320 px side by side: wider than a 360 px phone's content
    // once "Back to mentorship" is the label. The row has to be allowed to wrap.
    const rows = [...walk(parseMarkup(thanks))].filter(
      (e) => /display:\s*flex/.test(e.attrs.style ?? "") && e.children.filter((c) => c.tag === "a").length >= 2,
    );
    assert.equal(rows.length, 1, "the thank-you page's button row");
    assert.match(rows[0]!.attrs.style ?? "", /flex-wrap:\s*wrap/, "the button row wraps");
  });
});

// ── the phone form's star rating ─────────────────────────────────────────────

test("a phone form's 1-5 star rating sits on one line on a 360 px phone; a longer scale may wrap", { skip }, async () => {
  await withWorld("phonestars", async (w) => {
    const form = await w.form("baseline", "mentor", {
      title: `Baseline ${w.T}`,
      fields: [{ name: "overall", label: "Overall", kind: "rating", required: true }],
    });
    const { default: RunnerPage } = await import(`${APP}/forms/[slug]/page.tsx`);
    const html = await asPhone(w.mentor, () =>
      RunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
    );
    const root = parseMarkup(html);
    const get = await resolverFor(root, PHONE_WIDTH);
    const row = [...walk(root)].find((e) => e.attrs["data-testid"] === "mobile-rating");
    assert.ok(row, "the runner's first screen is the star row");
    const stars = row.children.filter((c) => c.tag === "button");
    assert.equal(stars.length, 5, "a 1-5 scale");

    // The row's width on the phone: 360, less the shell, .page-body, the
    // section's and the runner's borders and the field screen's padding.
    const width = contentWidth(row, get);
    const gap = px(get(row, "column-gap") ?? get(row, "gap") ?? "0", row);
    const claims = stars.map((s) => lineBreakWidth(s, get));
    const line = claims.reduce((a, b) => a + b, 0) + gap * (stars.length - 1);
    assert.ok(
      line <= width,
      `the stars need ${line}px on one line (${claims.join(" + ")}, and ${gap}px gaps) of a ${width}px row at ${PHONE_WIDTH}px, so the scale splits across lines or runs off the edge`,
    );
    // However small they get, each star stays the runner's 44 px touch target
    // (spec 133: "Touch targets minimum 44x44 px"); they grow to fill the row.
    for (const [i, c] of claims.entries()) assert.ok(c >= 44, `star ${i + 1} can shrink to ${c}px`);
    assert.ok(stars.every((s) => flexOf(s, get).grow > 0), "the stars grow to share the row");

    // Ten stars (the schema allows up to 10) cannot share one line at their
    // floor: that row has to be allowed to wrap rather than run off the edge.
    const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
    const ten = renderSync(
      h(MobileFormRunner as never, {
        schema: { fields: [{ name: "overall", label: "Overall", kind: "rating", starsMax: 10 }] },
        onSubmit: async () => undefined,
      } as never),
    );
    assert.equal((ten.match(/data-testid="mobile-star-overall-/g) ?? []).length, 10, "a 1-10 scale");
    noIssues(await phoneLayoutIssues(ten), "a 1-10 star rating");
  });
});

// ── /inbox ───────────────────────────────────────────────────────────────────

test("the inbox fits a phone", { skip }, async () => {
  await withWorld("phoneinbox", async (w) => {
    await w.q(
      `INSERT INTO notifications (user_id, kind, subject, body, entity_type, entity_id) VALUES
         ($1, 'meeting.scheduled', $2, $3, 'mentor_pairing', $4),
         ($1, 'meeting.scheduled', $2, NULL, NULL, NULL)`,
      [w.teacherA.id, `Meeting ${w.T}`, `A meeting was scheduled ${"z".repeat(90)}`, w.pairingA],
    );
    const { default: InboxPage } = await import(`${APP}/inbox/page.tsx`);
    for (const sp of [{}, { filter: "unread" }]) {
      const html = await asPhone(w.teacherA, () => InboxPage({ searchParams: Promise.resolve(sp) }));
      assert.match(html, new RegExp(`Meeting ${w.T}`), "the notifications are listed");
      noIssues(await phoneLayoutIssues(html), `/inbox ${JSON.stringify(sp)}`);
    }
  });
});
