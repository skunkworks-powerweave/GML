// The mentorship, forms and inbox pages tell assistive technology what each
// control is, which filter is on, which step of a form this is, and which page
// this is -- read off the REAL rendered pages and components (F135).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
//   - The pairing page's add-commitment row had three controls and no label:
//     the text box and the due box had a placeholder only (gone once
//     something is typed), and the who select had no name at all.
//   - The pairings list's status chips and the inbox's All / Unread tabs
//     marked the one that is on by fill alone, with no aria-current.
//   - The phone form's progress dots said "Step 2 of 10" but not which step
//     was the current one (width and colour only), and each was an 8 x 8 px
//     button 6 px from the next -- under WCAG 2.5.8's 24 px target.
//   - None of these pages set a title, so every tab and history entry read
//     "Goldenmile RTT LMS" and Next's route announcer, which speaks only when
//     document.title changes, announced no navigation.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, withAppRouter, request, mount, hostElements, h, renderSync } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { parseMarkup, walk, type El } from "./_phone-layout.js";

const skip = needsDatabase();
after(closeAppPool);

const APP = "../../apps/web/src/app/(authenticated)";

async function page(who: Person, run: () => Promise<unknown>, device: "mobile" | "desktop" = "desktop"): Promise<string> {
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

// ── names ────────────────────────────────────────────────────────────────────

const UNNAMED_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

/**
 * Form controls with no name from a label: no aria-label, no aria-labelledby,
 * no <label for> pointing at them, and no <label> around them. A placeholder
 * does not count -- it disappears once something is typed. (The same rule as
 * ui-page-a11y.test.ts applies to the observation, video and repo pages.)
 */
function unnamedControls(html: string): string[] {
  const root = parseMarkup(html);
  const labelled = new Set<string>();
  for (const el of walk(root)) if (el.tag === "label" && el.attrs.for) labelled.add(el.attrs.for);
  const insideLabel = (el: El) => {
    for (let n = el.parent; n; n = n.parent) if (n.tag === "label") return true;
    return false;
  };
  const notRendered = (el: El) => {
    for (let n: El | null = el; n; n = n.parent) {
      if ("hidden" in n.attrs || /display:\s*none/.test(n.attrs.style ?? "")) return true;
    }
    return false;
  };
  const out: string[] = [];
  for (const el of walk(root)) {
    if (!["input", "select", "textarea"].includes(el.tag)) continue;
    if (el.tag === "input" && UNNAMED_TYPES.has(el.attrs.type ?? "text")) continue;
    if (notRendered(el)) continue;
    const named =
      (el.attrs["aria-label"] ?? "").trim() !== "" ||
      (el.attrs["aria-labelledby"] ?? "").trim() !== "" ||
      (el.attrs.id !== undefined && labelled.has(el.attrs.id)) ||
      insideLabel(el);
    if (!named) out.push(`<${el.tag} name="${el.attrs.name ?? ""}">`);
  }
  return out;
}

test("every control on the pairing page, a form (desktop and phone), the catalogue and the inbox is named", { skip }, async () => {
  await withWorld("a11ypair", async (w) => {
    const form = await w.form("baseline", "mentor", {
      title: `Baseline ${w.T}`,
      fields: [
        { name: "summary", label: "Summary", kind: "text" },
        { name: "focus", label: "Focus", kind: "select", options: ["Reading", "Maths"] },
        { name: "notes", label: "Notes", kind: "textarea" },
      ],
    });
    const { default: Pairing } = await import(`${APP}/mentorship/[pairingId]/page.tsx`);
    const { default: Runner } = await import(`${APP}/forms/[slug]/page.tsx`);
    const { default: Forms } = await import(`${APP}/forms/page.tsx`);
    const { default: Inbox } = await import(`${APP}/inbox/page.tsx`);
    const pairingArgs = (sp: Record<string, string>) => () =>
      Pairing({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve(sp) });

    const mentorPage = await page(w.mentor, pairingArgs({ logMeeting: "1" }));
    for (const name of ["text", "who", "due", "scheduledAt", "durationMin", "notes"]) {
      assert.match(mentorPage, new RegExp(`name="${name}"`), `the mentor's pairing page shows ${name}`);
    }
    assert.deepEqual(unnamedControls(mentorPage), [], "/mentorship/[pairingId] as the mentor, logging a meeting");
    assert.deepEqual(unnamedControls(await page(w.teacherA, pairingArgs({}))), [], "/mentorship/[pairingId] as the mentee");

    for (const device of ["desktop", "mobile"] as const) {
      const html = await page(
        w.mentor,
        () => Runner({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
        device,
      );
      assert.match(html, /name="summary"/, `${device}: the form's first field is on the page`);
      assert.deepEqual(unnamedControls(html), [], `/forms/[slug] on a ${device}`);
    }
    assert.deepEqual(unnamedControls(await page(w.mentor, () => Forms({ searchParams: Promise.resolve({}) }))), [], "/forms");
    assert.deepEqual(unnamedControls(await page(w.mentor, () => Inbox({ searchParams: Promise.resolve({}) }))), [], "/inbox");
  });
});

// ── the filter that is on ────────────────────────────────────────────────────

/** Links to `path` itself or `path?...` (not the pager's ?page=), and whether each is aria-current="page". */
function chips(html: string, path: string): Array<{ href: string; current: boolean }> {
  const out: Array<{ href: string; current: boolean }> = [];
  for (const el of walk(parseMarkup(html))) {
    const href = el.attrs.href;
    if (el.tag !== "a" || href === undefined) continue;
    if (href !== path && !href.startsWith(`${path}?`)) continue;
    if (/[?&]page=/.test(href)) continue;
    out.push({ href, current: el.attrs["aria-current"] === "page" });
  }
  return out;
}

function assertCurrent(html: string, path: string, here: string, expected: number, where: string) {
  const all = chips(html, path);
  assert.equal(all.length, expected, `${where}: found the filter chips`);
  assert.ok(all.some((c) => c.href === here), `${where}: a chip links to ${here}`);
  for (const c of all) {
    assert.equal(c.current, c.href === here, `${where}: chip ${c.href} ${c.href === here ? "is" : "is not"} the current filter`);
  }
}

test("the pairings list's status chip and the inbox tab that are on say so (aria-current), and no other does", { skip }, async () => {
  await withWorld("a11ychip", async (w) => {
    const { default: List } = await import(`${APP}/mentorship/page.tsx`);
    // Six status chips: All, Active, In review, Paused, Complete, Ended.
    assertCurrent(await page(w.mentor, () => List({ searchParams: Promise.resolve({}) })), "/mentorship", "/mentorship", 6, "/mentorship");
    assertCurrent(
      await page(w.mentor, () => List({ searchParams: Promise.resolve({ status: "active" }) })),
      "/mentorship",
      "/mentorship?status=active",
      6,
      "/mentorship?status=active",
    );

    const { default: Inbox } = await import(`${APP}/inbox/page.tsx`);
    assertCurrent(await page(w.teacherA, () => Inbox({ searchParams: Promise.resolve({}) })), "/inbox", "/inbox", 2, "/inbox");
    assertCurrent(
      await page(w.teacherA, () => Inbox({ searchParams: Promise.resolve({ filter: "unread" }) })),
      "/inbox",
      "/inbox?filter=unread",
      2,
      "/inbox?filter=unread",
    );
  });
});

// ── the phone form's step dots ───────────────────────────────────────────────

test("the phone form's progress dots mark the current step and are 24 px targets", async () => {
  const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  const schema = {
    fields: [
      { name: "a", label: "A", kind: "text" },
      { name: "b", label: "B", kind: "text" },
    ],
  };
  const m = mount(MobileFormRunner as (p: unknown) => unknown, { schema, onSubmit: async () => undefined });
  const dots = () => hostElements(m.rerender()).filter((el) => String(el.props["data-testid"] ?? "").startsWith("mobile-progress-dot-"));
  const current = () => dots().map((d) => d.props["aria-current"] ?? null);

  // Two questions and the review: three steps.
  assert.equal(dots().length, 3);
  assert.deepEqual(current(), ["step", null, null], "the first step is the current one");
  for (const d of dots()) {
    const style = d.props.style as { height?: number; minHeight?: number; width?: number; minWidth?: number };
    const tall = Math.max(style.height ?? 0, style.minHeight ?? 0);
    const wide = Math.max(style.width ?? 0, style.minWidth ?? 0);
    assert.ok(tall >= 24 && wide >= 24, `${String(d.props["aria-label"])} is ${wide} x ${tall} px`);
  }

  // Next moves the current step, and aria-current moves with it.
  const next = hostElements(m.rerender()).find((el) => el.props["data-testid"] === "mobile-form-next")!;
  (next.props.onClick as () => void)();
  assert.deepEqual(current(), [null, "step", null], "after Next, the second step is the current one");

  // The visible pill is unchanged: still 8 px, the current one 28 px wide.
  const html = renderSync(h(MobileFormRunner as never, { schema, onSubmit: async () => undefined } as never));
  const dotsEl = [...walk(parseMarkup(html))].find((e) => e.attrs["data-testid"] === "mobile-progress-dots")!;
  const pills = dotsEl.children.map((b) => b.children[0]?.attrs.style ?? "");
  assert.match(pills[0]!, /height:\s*8px;.*width:\s*28px/, "the current pill is 28 x 8");
  assert.match(pills[1]!, /height:\s*8px;.*width:\s*8px/, "the others are 8 x 8");
});

// ── the page's own name ──────────────────────────────────────────────────────

// { skip }: importing a page imports @gml/db, which refuses to load without
// DATABASE_URL -- although nothing here queries it.
test("every mentorship, forms and inbox page has its own title", { skip }, async () => {
  const { metadata: root } = (await import("../../apps/web/src/app/layout.tsx")) as {
    metadata: { title: { template: string; default: string } };
  };
  const routes = [
    "mentorship/page.tsx",
    "mentorship/[pairingId]/page.tsx",
    "mentorship/[pairingId]/responses/page.tsx",
    "forms/page.tsx",
    "forms/[slug]/page.tsx",
    "forms/[slug]/thanks/page.tsx",
    "inbox/page.tsx",
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
