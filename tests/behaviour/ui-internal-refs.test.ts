// No internal tracking reference is shown to a user -- read off the REAL
// rendered pages (W3-73).
//
// SM-1..SM-9 and spec numbers are how this codebase cross-references its own
// reasoning. Written into copy, they reached people as text that means nothing
// to them:
//
//   /inbox, empty              "Notifications are kept for 90 days (SM-8)."
//   /admin/system-settings     "720p (deferred — spec 041)", with the tooltip
//                              "Deferred per spec 041 — worker pipeline does
//                              not transcode 720p today"
//
// (and on the RTT hub, the class page, the learner roster, the admin index and
// the quiz editor; tests/governance/test_user_copy_internal_refs.test.mjs
// sweeps every component, since no test renders every state of every page.)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { render, decodeEntities, elements, attr } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";
import { closeAppPool } from "./_mentorship.js";

const skip = needsDatabase();
after(closeAppPool);

const INTERNAL_REF = /\bSM-\d\b|\bspecs? \d{3}\b/i;
const APP = "../../apps/web/src/app/(authenticated)";

test("W3-73 /inbox: the empty inbox says how long notifications are kept, without a moat id", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("refs-inbox"));
    try {
      actAs(await f.user("teacher"), "teacher");
      const { default: InboxPage } = await import(`${APP}/inbox/page.tsx`);
      const html = decodeEntities(await render(await InboxPage({ searchParams: Promise.resolve({}) })));
      assert.match(html, /Nothing in your inbox yet\./, "the user has no notifications, so this is the empty state");
      assert.match(html, /Notifications are kept for 90 days\./);
      assert.doesNotMatch(html, INTERNAL_REF, `the inbox shows an internal reference: ${INTERNAL_REF.exec(html)?.[0]}`);
    } finally {
      await f.cleanup();
    }
  });
});

test("W3-73 /admin/system-settings: 720p says why it cannot be chosen, in words, not a spec number", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("refs-settings"));
    try {
      actAs(await f.user("super_admin"), "super_admin");
      const { default: SystemSettingsPage } = await import(`${APP}/admin/system-settings/page.tsx`);
      const raw = await render(await SystemSettingsPage({ searchParams: Promise.resolve({}) }));
      const html = decodeEntities(raw);
      const option = elements(raw, "option").find((o) => attr(o.open, "value") === "720p");
      assert.ok(option, "the quality picker lists 720p");
      assert.notEqual(attr(option.open, "disabled"), null, "720p cannot be chosen: the worker encodes up to 480p");
      assert.match(`${option.text} ${attr(option.open, "title")}`, /480p/, "720p says what is available instead");
      assert.doesNotMatch(html, INTERNAL_REF, `the settings page shows an internal reference: ${INTERNAL_REF.exec(html)?.[0]}`);
    } finally {
      await f.cleanup();
    }
  });
});
