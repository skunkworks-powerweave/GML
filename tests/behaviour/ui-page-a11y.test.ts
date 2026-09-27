// The observation, video, repository and dashboard pages tell assistive
// technology what each control is, which filter is on, and which page this
// is -- read off the REAL rendered pages (F135).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
//   - Form controls with no accessible name from a label: the cycle page's
//     stage answers sat under a <label> that neither wrapped them nor pointed
//     at them (so "Lesson plan summary" named nothing, and the placeholder that
//     stood in vanished once text was typed), the note box had a placeholder
//     only, and the video library's source filter and the repository's subject
//     and grade filters had no name at all.
//   - Filter chips marked the one that is on by fill colour alone, with no
//     aria-current, so a screen reader could not tell which filter the list
//     was showing; the reading-material pills changed hue and nothing else.
//   - No page set a title, so every tab, bookmark and history entry read
//     "Goldenmile RTT LMS" -- and Next's route announcer, which speaks only
//     when document.title CHANGES, said nothing on any navigation.
//   - --ink-4 text (#9b9080) is 2.78:1 on the paper background, under WCAG
//     AA's 4.5:1.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { parseMarkup, walk, type El } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)";

async function page(user: TestUser, run: () => Promise<unknown>): Promise<string> {
  signIn(user);
  return render(withAppRouter(await run()));
}

// ── names ────────────────────────────────────────────────────────────────────

const UNNAMED_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

/**
 * Form controls with no name from a label: no aria-label, no aria-labelledby,
 * no <label for> pointing at them, and no <label> around them. A placeholder
 * does not count -- it disappears once something is typed.
 */
function unnamedControls(html: string): string[] {
  const root = parseMarkup(html);
  const labelled = new Set<string>();
  for (const el of walk(root)) if (el.tag === "label" && el.attrs.for) labelled.add(el.attrs.for);
  const insideLabel = (el: El) => {
    for (let n = el.parent; n; n = n.parent) if (n.tag === "label") return true;
    return false;
  };
  // Not rendered, so not announced: e.g. UploadProgress's file input, which
  // its "Upload video" button opens.
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

test("every answer box on a cycle page is named by its label, at each stage, for each role", { skip }, async () => {
  const w = await observationWorld("a11ycyc");
  try {
    await w.grant(w.teacher.id);
    await w.grant(w.observer.id);
    await w.grant(w.mentor.id);
    const { default: CyclePage } = await import(`${APP}/observation/[cycleId]/page.tsx`);
    const cases: Array<[string, TestUser, string]> = [
      ["nominated", w.teacher, "lessonPlanSummary"],
      ["pre_submitted", w.observer, "note"],
      ["observed", w.teacher, "whatWorked"],
      ["observed", w.mentor, "note"],
    ];
    for (const [status, user, expect] of cases) {
      const cyc = await w.cycle({ status });
      const html = await page(user, () => CyclePage({ params: Promise.resolve({ cycleId: cyc.id }), searchParams: Promise.resolve({}) }));
      assert.match(html, new RegExp(`name="${expect}"`), `${status} as ${user.role} shows ${expect}`);
      assert.deepEqual(unnamedControls(html), [], `${status} as ${user.role}`);
    }
  } finally {
    await w.cleanup();
  }
});

test("the video library's and the repository's filters are named", { skip }, async () => {
  const w = await observationWorld("a11yflt");
  try {
    const admin = { id: w.admin.id, role: "super_admin", name: w.admin.name, email: w.admin.email };
    const { default: Videos } = await import(`${APP}/videos/page.tsx`);
    assert.deepEqual(unnamedControls(await page(w.teacher, () => Videos({ searchParams: Promise.resolve({}) }))), [], "/videos");
    const { default: Nominate } = await import(`${APP}/observation/new/page.tsx`);
    assert.deepEqual(unnamedControls(await page(admin, () => Nominate({ searchParams: Promise.resolve({}) }))), [], "/observation/new");
    for (const list of ["sessions", "subjects", "teachers", "outlines", "schools", "students", "mentors", "resources"]) {
      const { default: List } = await import(`${APP}/repo/${list}/page.tsx`);
      const html = await page(admin, () => List({ searchParams: Promise.resolve({}) }));
      assert.deepEqual(unnamedControls(html), [], `/repo/${list}`);
    }
  } finally {
    await w.cleanup();
  }
});

// ── the filter that is on ────────────────────────────────────────────────────

/**
 * Chip links on `path` (its own URL with a query, or bare) and whether each
 * says aria-current="page". The pager's ?page= links are not chips.
 */
function chips(html: string, path: string): Array<{ href: string; current: boolean; el: El }> {
  const out: Array<{ href: string; current: boolean; el: El }> = [];
  for (const el of walk(parseMarkup(html))) {
    const href = el.attrs.href;
    if (el.tag !== "a" || href === undefined) continue;
    if (href !== path && !href.startsWith(`${path}?`)) continue;
    if (/[?&]page=/.test(href)) continue;
    out.push({ href, current: el.attrs["aria-current"] === "page", el });
  }
  return out;
}

/** The chips that link to the page being shown are exactly the ones marked current. */
function assertCurrent(html: string, path: string, here: string, where: string) {
  const all = chips(html, path);
  assert.ok(all.length >= 3, `${where}: found the filter chips (${all.length})`);
  const onHere = all.filter((c) => c.href === here);
  assert.ok(onHere.length >= 1, `${where}: a chip links to ${here}`);
  for (const c of all) {
    assert.equal(c.current, c.href === here, `${where}: chip ${c.href} ${c.href === here ? "is" : "is not"} the current filter`);
  }
}

test("the filter chip that is on says so (aria-current), and no other does", { skip }, async () => {
  const w = await observationWorld("a11ychip");
  try {
    await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    const admin = { id: w.admin.id, role: "super_admin", name: w.admin.name, email: w.admin.email };

    const { default: Obs } = await import(`${APP}/observation/page.tsx`);
    assertCurrent(await page(w.teacher, () => Obs({ searchParams: Promise.resolve({}) })), "/observation", "/observation", "/observation");
    assertCurrent(
      await page(w.teacher, () => Obs({ searchParams: Promise.resolve({ status: "observed" }) })),
      "/observation",
      "/observation?status=observed",
      "/observation?status=observed",
    );

    const { default: Videos } = await import(`${APP}/videos/page.tsx`);
    assertCurrent(await page(w.teacher, () => Videos({ searchParams: Promise.resolve({}) })), "/videos", "/videos", "/videos");
    assertCurrent(
      await page(w.teacher, () => Videos({ searchParams: Promise.resolve({ status: "ready" }) })),
      "/videos",
      "/videos?status=ready",
      "/videos?status=ready",
    );

    const { default: Sessions } = await import(`${APP}/repo/sessions/page.tsx`);
    assertCurrent(await page(admin, () => Sessions({ searchParams: Promise.resolve({}) })), "/repo/sessions", "/repo/sessions", "/repo/sessions");

    const { default: Schools } = await import(`${APP}/repo/schools/page.tsx`);
    assertCurrent(await page(admin, () => Schools({ searchParams: Promise.resolve({}) })), "/repo/schools", "/repo/schools", "/repo/schools");

    const { default: Resources } = await import(`${APP}/repo/resources/page.tsx`);
    const res = await page(admin, () => Resources({ searchParams: Promise.resolve({ kind: "Guide" }) }));
    assertCurrent(res, "/repo/resources", "/repo/resources?kind=Guide", "/repo/resources?kind=Guide");
    // Not by hue alone: the pill that is on differs in more than its colour class.
    const pill = chips(res, "/repo/resources").find((c) => c.current)!;
    const other = chips(res, "/repo/resources").find((c) => !c.current)!;
    assert.notEqual(pill.el.attrs.style ?? "", other.el.attrs.style ?? "", "the active pill has a cue besides its colour");
    assert.match(pill.el.attrs.style ?? "", /font-weight:\s*600/, "the active pill is bold");
  } finally {
    await w.cleanup();
  }
});

// ── the page's own name ──────────────────────────────────────────────────────

// { skip }: importing a page imports @gml/db, which refuses to load without
// DATABASE_URL -- although nothing here queries it.
test("every observation, video, repository and dashboard page has its own title", { skip }, async () => {
  const { metadata: root } = (await import("../../apps/web/src/app/layout.tsx")) as {
    metadata: { title: { template: string; default: string } };
  };
  assert.match(root.title.template, /%s/, "the root template adds the product name to each page's title");
  const routes = [
    "dashboard/page.tsx",
    "observation/page.tsx",
    "observation/new/page.tsx",
    "observation/[cycleId]/page.tsx",
    "videos/page.tsx",
    "videos/[id]/page.tsx",
    "repo/page.tsx",
    "repo/schools/page.tsx",
    "repo/school/[id]/page.tsx",
    "repo/class/[id]/page.tsx",
    "repo/class/[id]/learners/page.tsx",
    "repo/subjects/page.tsx",
    "repo/subject/[id]/page.tsx",
    "repo/outlines/page.tsx",
    "repo/outline/[id]/page.tsx",
    "repo/sessions/page.tsx",
    "repo/session/[id]/page.tsx",
    "repo/teachers/page.tsx",
    "repo/teacher/[id]/page.tsx",
    "repo/mentors/page.tsx",
    "repo/mentor/[id]/page.tsx",
    "repo/students/page.tsx",
    "repo/resources/page.tsx",
    "repo/resource/[id]/page.tsx",
    "repo/resource/[id]/view/page.tsx",
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

// ── contrast ─────────────────────────────────────────────────────────────────

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("--ink-4 text meets WCAG AA (4.5:1) on every surface it is used on", async () => {
  const css = await readFile(fileURLToPath(new URL("../../apps/web/src/app/globals.css", import.meta.url)), "utf8");
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)![1]!;
  const token = (name: string) => rootBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  const ink4 = token("ink-4")!;
  for (const surface of ["paper", "paper-2", "card", "card-hi"]) {
    const bg = token(surface)!;
    const ratio = contrast(ink4, bg);
    assert.ok(ratio >= 4.5, `--ink-4 ${ink4} on --${surface} ${bg} is ${ratio.toFixed(2)}:1`);
  }
});
