// The data grid offers a role only the controls it can use, on the desktop
// table and on the phone's card list; and programme admins now keep the
// students' table.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Add, Edit, Delete and the bulk selection were rendered to every reader of a
// grid, and each posts to an action that requires the entity's mutateRoles --
// so a programme_admin on learners (super_admin-only until now) was offered
// all four and sent to /forbidden, and so would everyone be on the read-only
// approvals and account-request lists. The phone's cards offered Export CSV
// to readers the export refuses.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real grid page rendered as a signed-in user against Postgres, on the
// desktop and phone layouts and in Bhoti; the real server actions and CSV
// routes for the learners permission.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { render, withAppRouter, request, decodeEntities } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, redirectOf, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, signIn } from "./_server-actions.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const actAs = (id: string, role: string) => signIn({ id, role });

async function grid(slug: string, sp: Record<string, string> = {}, device: "desktop" | "mobile" = "desktop"): Promise<string> {
  const { default: AdminGridPage } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");
  request.cookies = { "gml-device": device };
  return render(withAppRouter(await AdminGridPage({ params: Promise.resolve({ entity: slug }), searchParams: Promise.resolve(sp) })));
}

/** Markers of each write control the grid can render. */
const WRITE_CONTROLS = {
  addForm: /data-form-mode="create"/,
  editForm: /data-form-mode="edit"/,
  editLink: /data-action="edit-row"/,
  deleteButton: /data-confirm-delete="true"/,
  bulkSelect: /data-bulk-select-all="true"|data-bulk-row-checkbox="true"/,
};

function assertNoWriteControls(html: string, where: string): void {
  for (const [name, re] of Object.entries(WRITE_CONTROLS)) assert.doesNotMatch(html, re, `${where}: ${name} is rendered`);
}

type World = { f: Fixture; school: string; klass: string; learner: string; approval: string; padmin: string; sadmin: string };

async function world(f: Fixture, t: string): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: `S${code}`.slice(0, 16) });
  const klass = await f.row("classes", { school_id: school, grade: 4, stage: "Primary" });
  const learner = await f.row("learners", { class_id: klass, school_id: school, grade: 4, name: `Learner ${t}` });
  const padmin = await f.user("programme_admin", "pa");
  const sadmin = await f.user("super_admin", "sa");
  const approval = await f.row("approvals", { item_type: "session", item_id: learner, status: "pending", submitted_by_user_id: padmin });
  f.defer(`DELETE FROM learners WHERE class_id = $1`, [klass]);
  return { f, school, klass, learner, approval, padmin, sadmin };
}

test("a read-only list shows its rows and details, and no control that writes -- desktop and phone", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("ap-ctl-ro");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      for (const [id, role] of [
        [w.padmin, "programme_admin"],
        [w.sadmin, "super_admin"],
      ] as const) {
        actAs(id, role);
        const html = await grid("approvals");
        assertNoWriteControls(html, `approvals as ${role}`);
        assert.match(html, /data-testid="grid-read-only"/);
        assert.match(html, /data-action="view-row"/, "each row can still be opened");
        assert.ok(!decodeEntities(html).includes("Import CSV"), `${role}: the import is offered on a read-only list`);
        assert.match(html, new RegExp(`/api/admin/data/approvals/export`), "an administrator can still export it");

        // Opening a row shows its details, not a form that would be refused.
        const panel = await grid("approvals", { edit: w.approval });
        assert.match(panel, /data-row-panel="view"/);
        assert.match(panel, /data-testid="row-details"/);
        assertNoWriteControls(panel, `approvals ?edit= as ${role}`);

        const phone = await grid("approvals", {}, "mobile");
        assert.match(phone, /data-testid="mobile-cards-approvals"/);
        assert.match(phone, /data-card-action="view"/);
        assert.doesNotMatch(phone, /data-card-action="edit"/);
        assert.match(phone, /data-card-action="export"/, "an administrator may export the approvals history");
        assertNoWriteControls(phone, `approvals on the phone as ${role}`);
      }
    } finally {
      signIn(null);
      await f.cleanup();
    }
  });
});

test("a programme admin keeps the students' table: add, edit, delete and bulk controls, but no export", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("ap-ctl-learners");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");
      const html = await grid("learners", { "filter[classId]": w.klass });
      for (const [name, re] of Object.entries(WRITE_CONTROLS)) {
        if (name === "editForm") continue;
        assert.match(html, re, `learners as programme_admin: ${name} is missing`);
      }
      const panel = await grid("learners", { edit: w.learner });
      assert.match(panel, /data-row-panel="edit"/);
      assert.match(panel, WRITE_CONTROLS.editForm);
      assert.match(panel, WRITE_CONTROLS.deleteButton, "the edit panel can delete (the phone's only delete)");

      // The phone: Edit on each card, and no Export -- learners' CSV is super_admin's.
      const phone = await grid("learners", { "filter[classId]": w.klass }, "mobile");
      assert.match(phone, /data-card-action="edit"/);
      assert.doesNotMatch(phone, /data-card-action="export"/, "the card offered an export the route refuses");
      actAs(w.sadmin, "super_admin");
      assert.match(await grid("learners", { "filter[classId]": w.klass }, "mobile"), /data-card-action="export"/);
    } finally {
      signIn(null);
      await f.cleanup();
    }
  });
});

test("programme_admin adds, edits, deletes and imports students; the export stays super_admin's", { skip }, async () => {
  const { createRowAction, updateRowAction, deleteRowAction } = await import(
    "../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts"
  );
  const imp = await import("../../apps/web/src/app/api/admin/data/[entity]/import/route.ts");
  const exp = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  await withClient(async (c) => {
    const t = tag("ap-learners");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");
      const base = { entitySlug: "learners", classId: w.klass, schoolId: w.school, grade: "4", active: "true" };
      const made = (await createRowAction(undefined, form({ ...base, name: `New ${t}`, rollNumber: "7" }))) as { ok?: boolean };
      assert.equal(made.ok, true, JSON.stringify(made));
      const id = (await c.query(`SELECT id FROM learners WHERE name = $1`, [`New ${t}`])).rows[0].id as string;
      const edited = (await updateRowAction(undefined, form({ ...base, rowId: id, name: `Renamed ${t}`, rollNumber: "7", section: "B" }))) as {
        ok?: boolean;
      };
      assert.equal(edited.ok, true, JSON.stringify(edited));
      assert.deepEqual((await c.query(`SELECT name, section FROM learners WHERE id = $1`, [id])).rows[0], { name: `Renamed ${t}`, section: "B" });
      assert.equal(await redirectOf(deleteRowAction(form({ entitySlug: "learners", rowId: id }))), null);
      assert.equal((await c.query(`SELECT 1 FROM learners WHERE id = $1`, [id])).rowCount, 0);

      const imported = await imp.POST(
        new Request("http://app.test/api/admin/data/learners/import", {
          method: "POST",
          body: `classId,schoolId,grade,name\n${w.klass},${w.school},4,Imported ${t}\n`,
        }),
        { params: Promise.resolve({ entity: "learners" }) },
      );
      assert.equal(imported.status, 200, await imported.clone().text());
      assert.equal((await c.query(`SELECT 1 FROM learners WHERE name = $1`, [`Imported ${t}`])).rowCount, 1);

      // A whole-table download of children's details stays super_admin's
      // (csv.ts sends anyone else to /forbidden).
      const refused = await redirectOf(
        exp.GET(new Request("http://app.test/api/admin/data/learners/export"), { params: Promise.resolve({ entity: "learners" }) }),
      );
      assert.equal(refused, "/forbidden");

      // Nobody else writes students.
      actAs(await f.user("teacher", "t"), "teacher");
      assert.equal(await redirectOf(createRowAction(undefined, form({ ...base, name: `Teacher's ${t}` }))), "/forbidden");
      assert.equal((await c.query(`SELECT 1 FROM learners WHERE name = $1`, [`Teacher's ${t}`])).rowCount, 0);
    } finally {
      signIn(null);
      await f.cleanup();
    }
  });
});

test("every new data table renders for a programme admin in English, Hindi and Bhoti, desktop and phone", { skip }, async () => {
  const slugs = [
    "grading-scales",
    "grading-bands",
    "observation-rubrics",
    "rubric-criteria",
    "teacher-classes",
    "session-attendance",
    "assessments",
    "assessment-marks",
    "quizzes",
    "approvals",
    "account-requests",
    "sessions",
    "course-outlines",
    "outline-lessons",
    "resources",
  ];
  await withClient(async (c) => {
    const t = tag("ap-ctl-all");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");
      for (const locale of ["en", "hi", "bo"] as const) {
        request.locale = locale;
        for (const slug of slugs) {
          // A missing message throws here (the test's intl provider fails on one).
          const html = await grid(slug);
          assert.match(html, /<table class="min-w-full text-sm">/, `${locale}: ${slug}`);
          await grid(slug, {}, "mobile");
        }
      }
    } finally {
      request.locale = "en";
      signIn(null);
      await f.cleanup();
    }
  });
});

test("bo: a read-only list says so in Bhoti, and names its table and columns in Bhoti", { skip }, async () => {
  const bo = loadMessages("bo") as { adminData: Record<string, never> };
  const en = loadMessages("en") as { adminData: Record<string, never> };
  const msg = (m: Record<string, unknown>, path: string) =>
    path.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], m) as string;
  await withClient(async (c) => {
    const t = tag("ap-ctl-bo");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");
      request.locale = "bo";
      const text = decodeEntities((await grid("approvals")).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
      for (const path of ["grid.readOnly", "entities.approvals.label", "entities.approvals.columns.submittedByUserId", "entities.approvals.enum.status.pending"]) {
        assert.ok(text.includes(msg(bo.adminData, path)), `bo: ${path} is not on the page`);
        assert.ok(!text.includes(msg(en.adminData, path)), `bo: the English ${path} is still on the page`);
      }
    } finally {
      request.locale = "en";
      signIn(null);
      await f.cleanup();
    }
  });
});
