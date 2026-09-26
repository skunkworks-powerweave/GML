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
import { actAs, fixture, form } from "./_admin-fixture.js";

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
  // Every value pairing_status holds, in the enum's order. This pinned
  // ["active", "paused", "ended"], the hand-written list that lacked "review"
  // and "complete", so saving such a pairing wrote "active" (FR-04,
  // tests/behaviour/admin-grid-enums.test.ts).
  assert.deepEqual(
    [...status.inner.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    ["active", "review", "paused", "ended", "complete"],
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

/**
 * What a browser submits for a rendered <form>: every named input's value,
 * every textarea's text, and every select's selected option -- or its FIRST
 * option when none is selected, which is exactly the behaviour at issue below.
 */
function submission(formHtml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of openingTags(formHtml, "input")) {
    const name = attr(tag, "name");
    if (name) out[name] = attr(tag, "value") ?? "";
  }
  for (const ta of elements(formHtml, "textarea")) {
    const name = attr(ta.open, "name");
    if (name) out[name] = ta.text;
  }
  for (const sel of elements(formHtml, "select")) {
    const name = attr(sel.open, "name");
    if (!name) continue;
    const options = openingTags(sel.inner, "option");
    const chosen = options.find((o) => /\sselected=""/.test(o)) ?? options[0];
    out[name] = chosen ? (attr(chosen, "value") ?? "") : "";
  }
  return out;
}

// ── THE LINK MUST SURVIVE AN UNRELATED EDIT ──────────────────────────────────
//
// An account picker lists only accounts with the roles the link is for
// (teachers.userId: teacher accounts) and hides deleted ones. A teacher record
// whose login has since been given another role (promoted to mentor on
// /admin/users) therefore rendered with NOTHING selected; the browser submits
// the first option, "— none —", and the edit action turns that into NULL. So
// correcting the teacher's phone number silently unlinked her login, and with
// it her cycles and pairings.
test("editing a record whose login is outside the picker's roles keeps the link", { skip }, async () => {
  const { default: AdminGridPage } = await gridPage();
  const { updateRowAction } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
  await withClient(async (c) => {
    const t = tag("grid-refs-keep");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: t.slice(-12) });
      const login = await f.user("mentor", "promoted");
      const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: login, phone: "+91 100" });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      request.cookies = { "gml-device": "desktop" };

      const html = await render(
        withAppRouter(
          await AdminGridPage({
            params: Promise.resolve({ entity: "teachers" }),
            searchParams: Promise.resolve({ edit: teacher }),
          }),
        ),
      );
      const editForm = elements(html, "form").find((el) => attr(el.open, "data-form-mode") === "edit");
      assert.ok(editForm, "the edit form is rendered");
      const pick = elements(editForm.inner, "select").find((s) => attr(s.open, "name") === "userId");
      assert.ok(pick, "the login is picked from a list");
      const selected = openingTags(pick.inner, "option").find((o) => /\sselected=""/.test(o));
      assert.equal(selected ? attr(selected, "value") : null, login, "the current login must be the selected option");
      assert.match(
        elements(pick.inner, "option").find((o) => attr(o.open, "value") === login)?.text ?? "",
        /not a teacher account/,
        "and say why it would not normally be offered",
      );

      const values = { ...submission(editForm.inner), phone: "+91 555" };
      assert.deepEqual(await updateRowAction(undefined, form(values)), { ok: true });
      const { rows: [row] } = await c.query(`SELECT user_id, phone FROM teachers WHERE id = $1`, [teacher]);
      assert.equal(row.phone, "+91 555");
      assert.equal(row.user_id, login, "editing the phone number unlinked the teacher's login");
    } finally {
      await f.cleanup();
    }
  });
});

// ── A GATED TABLE'S NAMES STAY BEHIND ITS GATE ───────────────────────────────
//
// Observation cycles are named by code, and classroom sessions (not gated)
// link to one. So /admin/data/sessions listed every cycle code in its picker,
// and in the grid, to a programme_admin who had never unlocked Observation.
test("an ungated grid does not name a gated table's rows without that gate", { skip }, async () => {
  const { default: AdminGridPage } = await gridPage();
  await withClient(async (c) => {
    const t = tag("grid-refs-gate");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: t.slice(-12) });
      const klass = await f.row("classes", { school_id: school, grade: 4, stage: "Primary" });
      const subject = await f.row("subjects", { name: `Subject ${t}`, code: t.slice(-12) });
      const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}` });
      const observer = await f.user("observer", "observer");
      const cycle = await f.row("observation_cycles", {
        code: `CYC-${t}`,
        teacher_id: teacher,
        observer_id: observer,
        kind: "baseline",
        scheduled_at: new Date("2026-10-01T04:30:00Z"),
      });
      await f.row("sessions", {
        school_id: school,
        class_id: klass,
        subject_id: subject,
        teacher_id: teacher,
        scheduled_date: "2026-10-01",
        topic: `Topic ${t}`,
        observation_cycle_id: cycle,
      });
      const admin = await f.user("programme_admin", "padmin");
      actAs(admin, "programme_admin");
      request.cookies = { "gml-device": "desktop" };
      const page = async () =>
        render(
          withAppRouter(
            await AdminGridPage({
              params: Promise.resolve({ entity: "sessions" }),
              searchParams: Promise.resolve({ "filter[topic]": `Topic ${t}` }),
            }),
          ),
        );

      assert.doesNotMatch(await page(), new RegExp(`CYC-${t}`), "a cycle code was shown without the observation password");

      await f.row("section_gate_grants", { user_id: admin, gate_slug: "observation", expires_at: new Date(Date.now() + 3600_000) });
      assert.match(await page(), new RegExp(`CYC-${t}`), "with the password, the cycle is picked by its code");
    } finally {
      await f.cleanup();
    }
  });
});

test("pickers are loaded only for the fields the page shows or edits", { skip }, async () => {
  const { referenceOptions } = await import("../../apps/web/src/admin/references.ts");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { ADMIN_ENTITIES } = await import("../../apps/web/src/admin/registry.ts");
  await withClient(async (c) => {
    const options = await referenceOptions(drizzle(c) as never, ADMIN_ENTITIES["rtt-attendance"]!, { gateOpen: async () => true });
    // markedByUserId is neither a form field nor a column: its picker was up
    // to 1,000 accounts' names and addresses, queried and shipped to the
    // browser on every page load for nothing.
    assert.deepEqual(Object.keys(options).sort(), ["rttSessionId", "teacherId"]);
  });
});
