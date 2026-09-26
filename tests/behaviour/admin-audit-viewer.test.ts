// The audit viewer can be narrowed by person and by date, and its export
// follows the same filters.
//
// ── THE DEFECTS ──────────────────────────────────────────────────────────────
//
// F75  The "User id" filter accepted only a UUID, and on rejection told the
//      operator to "copy the id from the User column below" -- a column that
//      shows the EMAIL. No admin screen displays a user id at all, so the
//      basic forensic question, "what did this person do?", could not be
//      asked from the UI.
// F73  The export answers 413 beyond 10,000 rows and says to narrow with
//      ?from= / ?to=, but the page had no date inputs and built its Export
//      link from the action and user only. Audit rows are written on ordinary
//      page views, so within days the only export in the UI returned a JSON
//      error instead of a CSV, with no explanation on the page.
//
// Executed: the real /admin/audit page (an async server component) rendered
// for a super_admin against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { render, elements, openingTags, attr } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const page = () => import("../../apps/web/src/app/(authenticated)/admin/audit/page.tsx");

async function view(sp: Record<string, string>): Promise<string> {
  const { default: AuditViewer } = await page();
  return render(await AuditViewer({ searchParams: Promise.resolve(sp) }));
}

test("the user filter takes an email address, and the User column links to it", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("audit-view");
    const f = fixture(c, t);
    try {
      const subject = await f.user("teacher", "subject");
      const other = await f.user("teacher", "other");
      const email = `subject.${t}@example.test`;
      await c.query(
        `INSERT INTO audit_log (user_id, action, entity_type, metadata) VALUES ($1, 'dashboard.viewed', $3, '{}'), ($2, 'dashboard.viewed', $3, '{}')`,
        [subject, other, t],
      );
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const html = await view({ user: email.toUpperCase() });
      assert.equal(
        elements(html, "p").some((p) => attr(p.open, "data-testid") === "audit-user-filter-rejected"),
        false,
        "an email address must be accepted",
      );
      const rows = elements(html, "tr").filter((r) => r.text.includes(t));
      assert.equal(rows.length, 1, "only the chosen person's events are listed");
      assert.match(rows[0]!.text, new RegExp(email.replace(/[.]/g, "\\.")));

      const link = openingTags(rows[0]!.inner, "a").find((a) => (attr(a, "href") ?? "").includes("user="));
      assert.ok(link, "the User cell links to that person's events");
      assert.match(attr(link, "href") ?? "", new RegExp(`user=${subject}`));

      const exportLink = openingTags(html, "a").find((a) => (attr(a, "href") ?? "").startsWith("/api/admin/audit/export"));
      assert.match(attr(exportLink ?? "", "href") ?? "", new RegExp(`user=${subject}`), "the export follows the user filter");
    } finally {
      await f.cleanup();
    }
  });
});

test("From and To narrow the view and are carried into the export link", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("audit-range");
    const f = fixture(c, t);
    try {
      await c.query(
        `INSERT INTO audit_log (action, entity_type, metadata, created_at) VALUES
           ('dashboard.viewed', $1, '{"n":"old"}', '2025-01-10T06:00:00Z'),
           ('dashboard.viewed', $1, '{"n":"new"}', '2025-02-10T06:00:00Z')`,
        [t],
      );
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const html = await view({ from: "2025-02-01", to: "2025-02-28" });
      for (const name of ["from", "to"]) {
        const box = openingTags(html, "input").find((i) => attr(i, "name") === name);
        assert.ok(box, `the filter form offers ${name}`);
        assert.equal(attr(box, "type"), "date");
      }
      const mine = elements(html, "tr").filter((r) => r.text.includes(t));
      assert.equal(mine.length, 1, "only the event inside the range is listed");
      assert.match(mine[0]!.text, /new/);
      const exportLink = openingTags(html, "a").find((a) => (attr(a, "href") ?? "").startsWith("/api/admin/audit/export"));
      const href = new URL(attr(exportLink ?? "", "href") ?? "/", "http://x");
      assert.ok(href.searchParams.get("from"), "the export carries the From date");
      assert.ok(href.searchParams.get("to"), "the export carries the To date");
    } finally {
      await f.cleanup();
    }
  });
});
