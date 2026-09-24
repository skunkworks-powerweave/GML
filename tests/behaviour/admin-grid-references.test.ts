// The no-code tables name their links instead of printing UUIDs.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// 18 admin entities link to another row by UUID, and every one of those links
// was a free text box: pairing a mentor with a teacher, putting a school in a
// zone or a term in a phase meant finding a UUID and pasting it. The grid then
// showed the UUID back, so a mistyped id could not be spotted. Form labels
// were raw keys (`mentorId`), enum fields were text boxes that accepted any
// spelling, and multi-paragraph fields were one-line inputs.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real RowForm rendered to HTML, and the real grid page (an async server
// component) rendered for a signed-in programme_admin against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render, renderSync, elements, openingTags, attr, withAppRouter, request } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();

const rowForm = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");
const gridPage = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");

const MENTOR = "11111111-1111-4111-8111-111111111111";
const TEACHER = "22222222-2222-4222-8222-222222222222";

test("a foreign key is picked by name, and the UUID is what gets submitted", async () => {
  const { RowForm } = await rowForm();
  const html = renderSync(
    h(RowForm, {
      entitySlug: "mentor-pairings",
      mode: "create",
      options: {
        mentorId: [{ id: MENTOR, label: "Dr. Anjali Bhatt" }],
        teacherId: [{ id: TEACHER, label: "Tsering Dolma" }],
      },
    }),
  );
  const selects = elements(html, "select");
  const mentor = selects.find((s) => attr(s.open, "name") === "mentorId");
  assert.ok(mentor, "mentorId must be a <select>, not a UUID text box");
  assert.match(mentor.inner, new RegExp(`<option value="${MENTOR}">Dr. Anjali Bhatt</option>`));
  assert.ok(
    !openingTags(html, "input").some((t) => attr(t, "name") === "mentorId"),
    "no free-text UUID box for a linked row",
  );
  assert.match(html, />Mentor(<| )/, "labelled as the grid labels it, not as the key `mentorId`");
  assert.doesNotMatch(html, />mentorId</);
});

test("an enum is a choice and long text is a text area", async () => {
  const { RowForm } = await rowForm();
  const html = renderSync(h(RowForm, { entitySlug: "mentor-pairings", mode: "create", options: {} }));
  const status = elements(html, "select").find((s) => attr(s.open, "name") === "status");
  assert.ok(status, "status must offer its values, not a free text box");
  assert.deepEqual(
    [...status.inner.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    ["active", "paused", "ended"],
  );
  assert.ok(
    openingTags(html, "textarea").some((t) => attr(t, "name") === "conceptNote"),
    "a 5,000-character concept note is not a one-line input",
  );
});

test("the grid shows the linked row's name, and the form lists what it may link to", { skip }, async () => {
  const { default: AdminGridPage } = await gridPage();
  await withClient(async (c) => {
    const t = tag("grid-refs");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: t.slice(-12) });
      await f.row("teachers", { school_id: school, full_name: `Teacher ${t}` });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      request.cookies = { "gml-device": "desktop" };

      const html = await render(
        withAppRouter(
          await AdminGridPage({
            params: Promise.resolve({ entity: "teachers" }),
            searchParams: Promise.resolve({ "filter[fullName]": `Teacher ${t}` }),
          }),
        ),
      );
      const cells = elements(html, "td").map((td) => td.text);
      assert.ok(cells.includes(`School ${t} (${t.slice(-12)})`), "the School column names the school");
      assert.ok(!cells.includes(school), "the School column must not print the school's UUID");

      const pick = elements(html, "select").find((s) => attr(s.open, "name") === "schoolId");
      assert.ok(pick, "the add-row form picks the school from a list");
      assert.match(pick.inner, new RegExp(`value="${school}">School ${t}`));
    } finally {
      await f.cleanup();
    }
  });
});
