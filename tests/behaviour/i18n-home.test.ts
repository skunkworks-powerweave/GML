// The home area in Hindi and Bhoti: the dashboard, the inbox, Settings, the
// 404 and 403 pages, the section gate's replies, the first-run tour and the
// chrome's own strings. See _ui.ts.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// Choosing Hindi or Bhoti translated the menus and nothing below them. The
// dashboard's stat cards, to-dos and field map, the whole inbox, the Settings
// page, the error, 404 and 403 pages, the first-run tour, the confidentiality
// footer and every message the password and gate forms return stayed English
// under a Hindi or Bhoti menu: they were literals in the components, and the
// dashboard's own header said so on purpose ("chrome translates, content
// doesn't").
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real pages and components, rendered for a request in `hi` and in `bo`
// (server components through the next-intl stub, client components through
// the real provider or mount({ intl })). Each check asserts two things: the
// string from the home namespace, in that language, is on the page, and its
// English original is not. Pages that read the database run against Postgres
// (./_observation-world.ts) and skip without one.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, outcome } from "./_server-actions.js";
import { h, render, request, resetRequest, withAppRouter, mount, hostElements, textOf, decodeEntities, webRequire } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});
beforeEach(() => resetRequest());

const LOCALES = ["hi", "bo"] as const;
type Locale = (typeof LOCALES)[number] | "en";
const SCRIPT: Record<(typeof LOCALES)[number], RegExp> = { hi: /[ऀ-ॿ]/u, bo: /[ༀ-࿿]/u };

type Translate = ((key: string, values?: Record<string, unknown>) => string) & {
  rich: (key: string, values?: Record<string, unknown>) => unknown;
};
const { createTranslator } = webRequire("next-intl") as {
  createTranslator: (o: Record<string, unknown>) => Translate;
};
/** home.<key> in `locale`, formatted as the app formats it. */
const home = (locale: Locale): Translate =>
  createTranslator({ locale, messages: loadMessages(locale), namespace: "home", timeZone: "Asia/Kolkata" });

/** The page's visible text, tags dropped and entities decoded. */
const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** `translated` is on the page, in the locale's script; `english` is not. */
function shows(page: string, locale: (typeof LOCALES)[number], translated: string, english: string, what: string) {
  assert.match(translated, SCRIPT[locale], `${locale}: ${what} is in the ${locale === "hi" ? "Devanagari" : "Tibetan"} script`);
  assert.ok(page.includes(translated), `${locale}: ${what} reads "${translated}"`);
  assert.ok(!page.includes(english), `${locale}: ${what} is still English ("${english}")`);
}

// ── Pages with no data ───────────────────────────────────────────────────────

test("the 404 page is in the reader's language", async () => {
  const { default: NotFound } = await import("../../apps/web/src/app/not-found.tsx");
  const en = home("en");
  for (const locale of LOCALES) {
    request.locale = locale;
    const page = text(await render(h(NotFound)));
    const t = home(locale);
    shows(page, locale, t("notFound.title"), en("notFound.title"), "the heading");
    shows(page, locale, t("notFound.goToDashboard"), en("notFound.goToDashboard"), "the way back");
  }
});

test("the 403 page gives each reason in the reader's language", async () => {
  const { default: Forbidden } = await import("../../apps/web/src/app/forbidden/page.tsx");
  const en = home("en");
  for (const locale of LOCALES) {
    request.locale = locale;
    const t = home(locale);
    const expired = text(await render(await Forbidden({ searchParams: Promise.resolve({ reason: "session_expired" }) })));
    shows(expired, locale, t("forbidden.sessionExpired.message"), en("forbidden.sessionExpired.message"), "the expired-session message");
    const signIn = (loadMessages(locale).action as unknown as Record<string, string>).signIn;
    assert.ok(expired.includes(signIn), `${locale}: its button is the chrome's "Sign in", translated`);
    const denied = text(await render(await Forbidden({})));
    shows(denied, locale, t("forbidden.default.message"), en("forbidden.default.message"), "the permission message");
  }
});

test("the dashboard's field map is in the reader's language, the school names as stored", async () => {
  const { FieldMapSection } = await import("../../apps/web/src/app/(authenticated)/dashboard/FieldMap.tsx");
  const en = home("en");
  const schools = [{ id: "s1", code: "GHS-LEH", name: "GHS Leh", districtCode: "LEH" }];
  for (const locale of LOCALES) {
    request.locale = locale;
    const html = await render(h(FieldMapSection, { schools }));
    const page = text(html);
    const t = home(locale);
    shows(page, locale, t("dashboard.fieldMap.title"), en("dashboard.fieldMap.title"), "the card heading");
    shows(page, locale, t("dashboard.fieldMap.summary", { count: 1 }), "click a marker", "the instruction");
    shows(page, locale, t("dashboard.fieldMap.kargilMap"), "KARGIL", "the district drawn on the map");
    assert.match(html, /<title>GHS Leh \(GHS-LEH\)<\/title>/, `${locale}: a school's name is data and is shown as stored`);
    const empty = text(await render(h(FieldMapSection, { schools: [] })));
    shows(empty, locale, t("dashboard.fieldMap.empty"), en("dashboard.fieldMap.empty"), "the empty state");
  }
});

test("the confidentiality footer on every page is in the reader's language", async () => {
  const { ConfidentialityFooter } = await import("../../apps/web/src/components/ConfidentialityFooter.tsx");
  for (const locale of LOCALES) {
    request.locale = locale;
    const page = text(await render(h(ConfidentialityFooter, { user: { name: "Tsering Dolma" } })));
    const t = home(locale);
    // A rich message (<strong>, <code>): its words, with the tags' contents.
    const chunks = t.rich("chrome.footer.full", { stamp: "Tsering Dolma", strong: (c: unknown) => c, code: (c: unknown) => c });
    const words = [chunks].flat(3).join("").replace(/\s+/g, " ").trim();
    assert.ok(page.includes(words.slice(0, 20)), `${locale}: the notice reads "${words}"`);
    assert.ok(page.includes("Tsering Dolma"), `${locale}: the viewer's name is shown as stored`);
    assert.ok(!page.includes("All materials on this platform"), `${locale}: the notice is still English`);
  }
});

// ── Client components ────────────────────────────────────────────────────────

test("the first-run tour speaks the reader's language (a client component, mounted)", async () => {
  const { FTUXTour } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  const en = home("en");
  for (const locale of LOCALES) {
    const m = mount(FTUXTour as (p: unknown) => unknown, { role: "mentor", ftuxSeenAt: null, whatsapp: true }, { intl: locale });
    const all = textOf(m.tree);
    const t = home(locale);
    shows(all, locale, t("client.tour.steps.mentees.title"), en("client.tour.steps.mentees.title"), "the first step's title");
    shows(all, locale, t("client.tour.progress", { step: 1, total: 5 }), "Tour · step", "the step counter");
    shows(all, locale, t("client.tour.skip"), en("client.tour.skip"), "the Skip button");
    const dialog = hostElements(m.tree).find((el) => el.props.role === "dialog");
    assert.equal(dialog?.props["aria-label"], t("client.tour.ariaLabel"), `${locale}: the dialog is named in the reader's language`);
  }
});

test("Settings' own sections are in the reader's language (a client component, rendered)", async () => {
  const { SettingsForm } = await import("../../apps/web/src/app/(authenticated)/settings/settings-form.tsx");
  const en = home("en");
  const initial = { density: "regular", fontScale: "regular", highContrast: false, reducedMotion: false, showWatermark: true, uiLanguage: "hi" };
  for (const locale of LOCALES) {
    request.locale = locale;
    const page = text(
      await render(withAppRouter(h(SettingsForm, { initial, email: "t@example.org", roleLabel: "x", roleChipKind: "" }))),
    );
    const t = home(locale);
    shows(page, locale, t("client.settingsForm.display"), "Display", "the Display card");
    shows(page, locale, t("client.settingsForm.highContrast"), en("client.settingsForm.highContrast"), "the High contrast switch");
    shows(page, locale, t("client.settingsForm.watermarkTitle"), en("client.settingsForm.watermarkTitle"), "the watermark statement");
    shows(page, locale, t("client.changePassword.open"), en("client.changePassword.open"), "the password control");
    assert.ok(page.includes("t@example.org"), `${locale}: the email is data, shown as stored`);
  }
});

// ── Pages that read the database ─────────────────────────────────────────────

test("the dashboard is in the reader's language: cards, to-dos and the date", { skip }, async () => {
  const w = await observationWorld("i18nhome");
  try {
    // A teacher with no observation grant: her cycle cards read "locked" and
    // her to-do list offers the unlock -- the gated strings, the stat labels
    // and the to-do together.
    await w.cycle({ status: "nominated" });
    signIn(w.teacher);
    const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
    const en = home("en");
    for (const locale of LOCALES) {
      request.locale = locale;
      const r = await outcome(() => DashboardPage());
      assert.equal(r.kind, "returned");
      const page = text(await render(withAppRouter((r as { value: unknown }).value)));
      const t = home(locale);
      shows(page, locale, t("dashboard.stats.pendingPre"), en("dashboard.stats.pendingPre"), "the pre-form card");
      shows(page, locale, t("dashboard.stats.observationLocked"), en("dashboard.stats.observationLocked"), "the locked section's hint");
      shows(page, locale, t("dashboard.todos.unlockObservation"), en("dashboard.todos.unlockObservation"), "the unlock to-do");
      shows(page, locale, t("dashboard.queueTeacher"), en("dashboard.queueTeacher"), "the to-do card's subtitle");
      shows(page, locale, t("dashboard.confidentialityNote"), "All resources here are confidential", "the confidentiality card");
      // The date is formatted for the language (INTL_LOCALE), not en-IN.
      assert.doesNotMatch(page, /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/, `${locale}: the date names an English weekday`);
    }
  } finally {
    signIn(null);
    await w.cleanup();
  }
});

test("the inbox is in the reader's language; a notification's subject is shown as stored", { skip }, async () => {
  const w = await observationWorld("i18ninbox");
  try {
    // Deleted with the user (notifications cascade).
    await w.c.query(
      `INSERT INTO notifications (user_id, kind, subject, entity_type, entity_id) VALUES ($1, 'meeting.scheduled', $2, 'meeting', $3)`,
      [w.teacher.id, `Meeting ${w.T}`, w.pairingId],
    );
    signIn(w.teacher);
    const { default: InboxPage } = await import("../../apps/web/src/app/(authenticated)/inbox/page.tsx");
    const en = home("en");
    for (const locale of LOCALES) {
      request.locale = locale;
      const r = await outcome(() => InboxPage({ searchParams: Promise.resolve({}) }));
      assert.equal(r.kind, "returned");
      const page = text(await render((r as { value: unknown }).value));
      const t = home(locale);
      shows(page, locale, t("inbox.markAllRead"), en("inbox.markAllRead"), "the Mark all read button");
      shows(page, locale, t("inbox.bucket.today"), " Today ", "today's group heading");
      shows(page, locale, t("inbox.kind.meetingScheduled"), "meeting.scheduled", "the notification's kind");
      shows(page, locale, t("inbox.counts", { unread: 1, total: 1 }), "1 unread · 1 total", "the counts");
      assert.ok(page.includes(`Meeting ${w.T}`), `${locale}: the stored subject is shown as it was written`);
    }
  } finally {
    signIn(null);
    await w.cleanup();
  }
});

test("the section gate and the password form answer in the reader's language", { skip }, async () => {
  const { verifyGate } = await import("../../apps/web/src/app/gate/[slug]/actions.ts");
  const { changePasswordAction } = await import("../../apps/web/src/app/(authenticated)/settings/actions.ts");
  const en = home("en");
  signIn(null);
  for (const locale of LOCALES) {
    request.locale = locale;
    const t = home(locale);
    const gate = await verifyGate(undefined, new FormData());
    assert.equal(gate.error, t("gate.signInFirst"), `${locale}: the gate's reply`);
    assert.notEqual(gate.error, en("gate.signInFirst"));
    const pw = await changePasswordAction(undefined, new FormData());
    assert.equal(pw.error, t("settings.password.sessionEnded"), `${locale}: the password form's reply`);
    assert.match(pw.error ?? "", SCRIPT[locale]);
  }
});
