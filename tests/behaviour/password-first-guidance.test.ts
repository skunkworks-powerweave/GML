// A new account's first screen says why the menu goes nowhere, and opens the
// dashboard once the password is changed.
//
// ── THE DEFECT (live QA, 9 Oct 2026) ─────────────────────────────────────────
//
// An administrator created a teacher login. The teacher signed in and reported:
// "Cannot click on any of the left menu" and "it lands me on Settings, not the
// dashboard". Both were the forced first password change working as designed:
// the proxy sends every page to /settings until a password an administrator
// set is replaced. But nothing on screen said so. Settings opened on "Your
// preferences"; the one line explaining it sat in the Account card at the
// bottom, below the fold; each menu click bounced back to the same page in
// silence; and after the change the teacher stayed on Settings.
//
// Now: Settings says it at the top with a button to the form, the sidebar is
// dimmed under a note linking to it (the phone's tabs are dimmed), and a
// required change ends on the dashboard.
//
// Executed: the real (authenticated) layout and Settings page against the test
// database, the password action's result, and the form's hand-off under the
// mount() hook harness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { h, hostElements, mount, render, request, resetRequest, textOf, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));

function signInNew(mustChangePassword: boolean | undefined, device: "desktop" | "mobile" = "desktop"): void {
  resetRequest();
  request.session = {
    user: { id: randomUUID(), email: "new@example.org", name: "New Teacher", image: null, role: "teacher", mustChangePassword },
  };
  request.cookies["gml-device"] = device;
}

/** The opening tag of the link to `href` in rendered HTML. */
function linkTo(html: string, href: string): string {
  const tag = html.match(/<a [^>]*>/g)?.find((t) => t.includes(`href="${href}"`));
  assert.ok(tag, `a link to ${href}`);
  return tag;
}

async function shell(): Promise<string> {
  const { default: AuthenticatedLayout } = await import("../../apps/web/src/app/(authenticated)/layout.tsx");
  return render(withAppRouter(await AuthenticatedLayout({ children: h("p", null, "page") })));
}

async function settings(): Promise<string> {
  const { default: SettingsPage } = await import("../../apps/web/src/app/(authenticated)/settings/page.tsx");
  return render(withAppRouter(await SettingsPage()));
}

test("Settings says at the top that the password comes first, with a button to the form", { skip }, async () => {
  signInNew(true);
  const html = await settings();
  const banner = html.indexOf('data-testid="password-required-banner"');
  assert.ok(banner >= 0, "the banner shows");
  assert.ok(banner < html.indexOf("Display"), "above the preference cards, where the page opens");
  assert.ok(html.includes("Choose your own password to continue"));
  assert.match(html, /href="#change-password"[^>]*data-testid="password-required-go"/, "the button jumps to the form");
  assert.match(html, /id="change-password"/, "and the form's row is the target");
  assert.match(html, /data-testid="password-change-required"/, "the form itself is open and says why");
});

test("an ordinary Settings visit shows no banner", { skip }, async () => {
  signInNew(undefined);
  const html = await settings();
  assert.ok(!html.includes('data-testid="password-required-banner"'));
  assert.ok(!html.includes("Choose your own password to continue"));
});

test("the sidebar is dimmed under a note that links to the password form, and says the items are unavailable", { skip }, async () => {
  signInNew(true);
  const html = await shell();
  assert.match(linkTo(html, "/settings#change-password"), /id="nav-locked-note"[^>]*data-testid="nav-locked"/, "a note linking to the form");
  assert.ok(html.includes("Menu locked. Choose your own password in Settings to open it."));
  const dashboard = linkTo(html, "/dashboard");
  assert.match(dashboard, /aria-disabled="true"/, "announced as unavailable, not as a plain link");
  assert.match(dashboard, /aria-describedby="nav-locked-note"/, "with the note as the reason");
  assert.match(dashboard, /opacity:0\.5/, "and dimmed");
  const settingsItem = linkTo(html, "/settings");
  assert.doesNotMatch(settingsItem, /aria-disabled|opacity:0\.5/, "Settings, where the note sends you, stays as it is");
  assert.ok(html.includes("<p>page</p>"), "the page itself still renders");

  signInNew(undefined);
  const normal = await shell();
  assert.ok(!normal.includes('data-testid="nav-locked"'), "no note once the password is the user's own");
  assert.doesNotMatch(linkTo(normal, "/dashboard"), /aria-disabled|opacity:0\.5/, "and the menu is as usual");
});

test("the note is in the user's language", { skip }, async () => {
  signInNew(true);
  request.locale = "hi";
  const hi = await shell();
  assert.ok(hi.includes("मेनू लॉक है। इसे खोलने के लिए सेटिंग्स में अपना पासवर्ड चुनें।"));
  signInNew(true);
  request.locale = "bo";
  const bo = await shell();
  assert.ok(bo.includes("དཀར་ཆག་སྒོ་བརྒྱབ་ཡོད།"));
});

test("on a phone the bottom tabs are dimmed and say why to a screen reader", { skip }, async () => {
  signInNew(true, "mobile");
  const html = await shell();
  assert.match(html, /class="m-bottomnav"[^>]*data-locked="true"/);
  const tab = linkTo(html, "/dashboard");
  assert.match(tab, /aria-disabled="true"/);
  assert.match(tab, /aria-describedby="nav-locked-note-tabs"/);
  assert.match(tab, /opacity:0\.5/, "the tabs are dimmed, not the bar");
  assert.match(html, /<span id="nav-locked-note-tabs"[^>]*>Menu locked\. Choose your own password in Settings to open it\.<\/span>/);

  signInNew(undefined, "mobile");
  const normal = await shell();
  assert.ok(!normal.includes('data-locked="true"'));
  assert.doesNotMatch(linkTo(normal, "/dashboard"), /aria-disabled/);
});

test("the first-run tour waits through the password change's own response, and plays on the next page", { skip }, async () => {
  // The change's response re-renders the layout from the new token (no flag):
  // without the guard the tour opened over "Password changed".
  signInNew(undefined);
  request.headers["next-action"] = "an-action-id";
  request.headers["x-pathname"] = "/settings";
  assert.ok(!(await shell()).includes("ftux-root"), "not over the confirmation");

  signInNew(undefined);
  request.headers["x-pathname"] = "/settings";
  assert.ok((await shell()).includes("ftux-root"), "a plain Settings load (Replay tour reloads it) still gets the tour");

  signInNew(undefined);
  request.headers["next-action"] = "an-action-id";
  request.headers["x-pathname"] = "/teaching/sessions";
  assert.ok((await shell()).includes("ftux-root"), "an action anywhere else is not held");
});

/** A browser for the hand-off: timers and navigation, recorded. */
function fakeWindow() {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const assigned: string[] = [];
  let cleared = 0;
  const g = globalThis as Record<string, unknown>;
  const saved = g.window;
  g.window = {
    setTimeout: (fn: () => void, ms: number) => scheduled.push({ fn, ms }),
    clearTimeout: () => void cleared++,
    location: { assign: (href: string) => assigned.push(href) },
  };
  return { scheduled, assigned, cleared: () => cleared, restore: () => void (g.window = saved) };
}

// The form imports its server action, and through it @gml/db, which needs
// DATABASE_URL at import time: these skip without a database like the rest.
const form = () => import("../../apps/web/src/app/(authenticated)/settings/ChangePasswordForm.tsx");

test("the form hands off on the action's word, even once the page has re-rendered without the flag", { skip }, async () => {
  const { ChangePasswordForm, ContinueToDashboard } = await form();
  // required=false and no ?password=required: exactly what Settings renders in
  // the action's own response, after the token lost the flag.
  const done = mount(ChangePasswordForm, { required: false }, { intl: "en", actionState: { ok: "Password changed.", continueToDashboard: true } });
  assert.equal((done.tree as { type: unknown }).type, ContinueToDashboard, "on to the dashboard");
  assert.equal((done.tree as { props: { warning: boolean } }).props.warning, false);

  const warned = mount(ChangePasswordForm, { required: false }, {
    intl: "en",
    actionState: { ok: "Password changed, but…", continueToDashboard: true, othersStillSignedIn: true },
  });
  assert.equal((warned.tree as { props: { warning: boolean } }).props.warning, true, "the warning case is passed on");

  const voluntary = mount(ChangePasswordForm, { required: false }, { intl: "en", actionState: { ok: "Password changed." } });
  assert.notEqual((voluntary.tree as { type: unknown }).type, ContinueToDashboard, "a change nobody required stays on Settings");
  assert.equal(textOf(voluntary.tree), "Password changed.");
});

test("after a clean required change the dashboard opens by itself, once the confirmation has been read", { skip }, async () => {
  const { ContinueToDashboard, CONTINUE_AFTER_MS } = await form();
  const w = fakeWindow();
  try {
    const m = mount(ContinueToDashboard, { message: "Password changed." }, { effects: true, intl: "en" });
    assert.match(textOf(m.tree), /Password changed\. Opening your dashboard…/);
    assert.equal(w.scheduled.length, 1, "one hand-off is scheduled");
    assert.equal(w.scheduled[0]!.ms, CONTINUE_AFTER_MS);
    assert.ok(CONTINUE_AFTER_MS >= 2500, "time to read it in Hindi or Bhoti too");
    assert.deepEqual(w.assigned, [], "not before");
    w.scheduled[0]!.fn();
    assert.deepEqual(w.assigned, ["/dashboard"], "a full load of the dashboard");
    m.unmount();
    assert.equal(w.cleared(), 1, "leaving the page first cancels it");

    const go = hostElements(m.tree).find((e) => e.props["data-testid"] === "password-changed-go");
    assert.ok(go, "a button to go at once");
    (go.props.onClick as () => void)();
    assert.deepEqual(w.assigned, ["/dashboard", "/dashboard"]);
  } finally {
    w.restore();
  }
});

test("when other devices could not be signed out, the warning stays until they choose to go on", { skip }, async () => {
  const { ContinueToDashboard } = await form();
  const w = fakeWindow();
  try {
    const warning = "Password changed, but your other devices could not be signed out from here. Sign out on them yourself.";
    const m = mount(ContinueToDashboard, { message: warning, warning: true }, { effects: true, intl: "en" });
    assert.deepEqual(w.scheduled, [], "no timer: nothing takes the warning away");
    const status = hostElements(m.tree).find((e) => e.props["data-testid"] === "password-changed-continuing");
    assert.equal(status?.props.role, "alert");
    assert.equal(textOf(status), warning, "the warning, without 'Opening your dashboard'");
    const go = hostElements(m.tree).find((e) => e.props["data-testid"] === "password-changed-go");
    assert.equal(go?.props.autoFocus, true, "the way on is focused");
    assert.equal(textOf(go), "Go to your dashboard");
    m.unmount();
  } finally {
    w.restore();
  }
});

test("a first shell guess the viewport contradicts is replaced at once, so an action cannot swap it mid-form", async () => {
  const { DeviceSync } = await import("../../apps/web/src/components/DeviceSync.tsx");
  const { AppRouterContext } = webRequire("next/dist/shared/lib/app-router-context.shared-runtime") as {
    AppRouterContext: { _currentValue: unknown };
  };
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, router: AppRouterContext._currentValue };
  const run = (initial: "mobile" | "desktop", narrow: boolean) => {
    let refreshes = 0;
    const listeners: Array<() => void> = [];
    const doc = { cookie: "" };
    g.document = doc;
    g.window = {
      matchMedia: () => ({ matches: narrow, addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener() {} }),
    };
    AppRouterContext._currentValue = { refresh: () => void refreshes++ };
    const m = mount(DeviceSync, { initial }, { effects: true });
    return { refreshes: () => refreshes, cookie: () => doc.cookie, rotate: () => listeners.forEach((fn) => fn()), m };
  };
  try {
    const wrong = run("desktop", true); // e.g. an iPad in portrait: a Mac UA, a phone-width viewport
    assert.match(wrong.cookie(), /^gml-device=mobile;/);
    assert.equal(wrong.refreshes(), 1, "the right shell is fetched straight away");
    wrong.rotate();
    assert.equal(wrong.refreshes(), 1, "a later rotation waits for the next navigation: nothing typed is thrown away");
    wrong.m.unmount();

    const right = run("mobile", true);
    assert.equal(right.refreshes(), 0, "a right guess costs nothing");
    right.m.unmount();
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    AppRouterContext._currentValue = saved.router;
  }
});
