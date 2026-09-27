// The first-run tour waits until a new user has chosen their own password.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// An account an administrator creates must choose its own password before
// anything else: the proxy sends every page to Settings until it does. But the
// (authenticated) layout mounted the first-run tour for every user with no
// ftux_seen_at, so the new user's first screen was "Tour · step 1 of 4" over
// the password form, pointing at RTT Phases and the other menu items that
// only led back to Settings.
//
// The layout now leaves the tour out while the session says the password must
// change. ftux_seen_at is still unset, so the tour plays on the first page the
// user opens after changing it.
//
// Executed: the real (authenticated) layout against the test database, for a
// user with no user_prefs row -- the "never seen the tour" signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { h, render, request, resetRequest, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();

async function shell(mustChangePassword: boolean | undefined): Promise<string> {
  resetRequest();
  // A fresh id: no user_prefs row, so the tour has never been seen.
  request.session = {
    user: { id: randomUUID(), email: "new@example.org", name: "New Teacher", image: null, role: "teacher", mustChangePassword },
  };
  request.cookies["gml-device"] = "desktop";
  const { default: AuthenticatedLayout } = await import("../../apps/web/src/app/(authenticated)/layout.tsx");
  return render(withAppRouter(await AuthenticatedLayout({ children: h("p", null, "page") })));
}

test("a user who has never seen the tour gets it", { skip }, async () => {
  const html = await shell(undefined);
  assert.ok(html.includes("<p>page</p>"));
  assert.ok(html.includes("ftux-root"), "the first-run tour mounts for a user who has not seen it");
});

test("the tour waits while an administrator-set password must still be changed", { skip }, async () => {
  const html = await shell(true);
  assert.ok(html.includes("<p>page</p>"), "the page itself still renders");
  assert.ok(!html.includes("ftux-root"), "no tour over the forced password change");
});
