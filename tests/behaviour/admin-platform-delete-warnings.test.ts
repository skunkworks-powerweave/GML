// A grid delete that also deletes or unlinks other data says so in its
// confirmation, before it happens.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// deleteRowAction issues one DELETE and leaves the rest to the foreign keys,
// and some still act on their own: an RTT lesson or reading takes every
// teacher's progress tick on it, a subject its resource tags, a student her
// attendance and marks; a phase stops being any teacher's current phase, an
// outline lesson any session's lesson, a module any RTT session's, and a
// deleted teacher's lesson plans are left with no owner. The confirmation said
// only "Delete <row>? This cannot be undone."
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// admin/delete-effects.ts over the real Drizzle schema, checked against the
// constraints Postgres actually holds; the real grid page as a programme
// admin, whose Delete buttons carry the warning; and the real Delete button,
// whose confirmation is read in Bhoti.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getTableName } from "drizzle-orm";
import { h, render, mount, withAppRouter, request, hostElements, textOf } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture } from "./_admin-fixture.js";
import { closeAppDb, signIn } from "./_server-actions.js";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { deleteEffects, deleteWarning, effectKey } from "../../apps/web/src/admin/delete-effects.ts";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const effectsOf = (slug: string) =>
  deleteEffects(ADMIN_ENTITIES[slug]!.table).map((e) => `${e.action}:${e.table}.${e.column}`);

/** The adminData translator for `locale`, as the grid page uses it. */
async function translator(locale: "en" | "hi" | "bo") {
  const { getTranslations } = await import("next-intl/server");
  request.locale = locale;
  try {
    return (await getTranslations("adminData")) as unknown as Parameters<typeof deleteWarning>[0];
  } finally {
    request.locale = "en";
  }
}

test("the effects come from the schema's own foreign-key rules", () => {
  assert.deepEqual(effectsOf("rtt-lessons"), ["cascade:rtt_progress.rtt_lesson_id"]);
  assert.deepEqual(effectsOf("rtt-readings"), ["cascade:rtt_progress.rtt_reading_id"]);
  assert.ok(effectsOf("subjects").includes("cascade:resource_subjects.subject_id"));
  assert.deepEqual(effectsOf("phases"), ["set null:teachers.current_phase_id"]);
  assert.deepEqual(effectsOf("outline-lessons"), ["set null:sessions.outline_lesson_id"]);
  assert.deepEqual(effectsOf("rtt-modules"), ["set null:rtt_sessions.rtt_module_id"]);
  assert.ok(effectsOf("teachers").includes("set null:course_outlines.owner_teacher_id"));
  assert.deepEqual(effectsOf("learners"), ["cascade:assessment_marks.learner_id", "cascade:session_attendance.learner_id"]);
  assert.ok(effectsOf("grading-scales").includes("cascade:grading_bands.scale_id"));
  // A table whose children refuse the delete warns of nothing: the refusal says why.
  assert.deepEqual(effectsOf("zones"), []);
  assert.deepEqual(effectsOf("districts"), []);
});

test("every effect of every data table is named in English, Hindi and Bhoti", async () => {
  const missing: string[] = [];
  for (const locale of ["en", "hi", "bo"] as const) {
    const messages = loadMessages(locale) as Record<string, unknown>;
    for (const [slug, entity] of Object.entries(ADMIN_ENTITIES)) {
      for (const effect of deleteEffects(entity.table)) {
        const path = `adminData.${effectKey(effect)}`;
        const v = path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], messages);
        if (typeof v !== "string") missing.push(`${locale}: ${slug} -> ${path}`);
      }
    }
  }
  assert.deepEqual(missing, []);
  // And the whole warning formats in each language.
  for (const locale of ["en", "hi", "bo"] as const) {
    const t = await translator(locale);
    for (const entity of Object.values(ADMIN_ENTITIES)) {
      const text = deleteWarning(t, entity.table);
      if (deleteEffects(entity.table).length) assert.ok(text && text.length > 10, `${locale}: ${entity.slug}`);
      else assert.equal(text, null);
    }
  }
});

test("the warnings match the constraints the database really holds", { skip }, async () => {
  await withClient(async (c) => {
    const checked: string[] = [];
    for (const entity of Object.values(ADMIN_ENTITIES)) {
      const parent = getTableName(entity.table);
      for (const e of deleteEffects(entity.table)) {
        const { rows } = await c.query(
          `SELECT con.confdeltype AS rule
             FROM pg_constraint con
             JOIN pg_class rel ON rel.oid = con.conrelid
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
            WHERE con.contype = 'f' AND rel.relname = $1 AND att.attname = $2 AND con.confrelid = $3::regclass`,
          [e.table, e.column, parent],
        );
        assert.equal(rows.length, 1, `${e.table}.${e.column} -> ${parent}: no such foreign key in the database`);
        assert.equal(rows[0].rule, e.action === "cascade" ? "c" : "n", `${e.table}.${e.column} -> ${parent}`);
        checked.push(`${e.table}.${e.column}`);
      }
    }
    assert.ok(checked.length >= 20, `only ${checked.length} checked`);
  });
});

type El = { type: unknown; props: Record<string, unknown> };
function findAll(node: unknown, type: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) findAll(n, type, out);
  else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as El;
    if (el.type === type) out.push(el);
    findAll(el.props.children, type, out);
  }
  return out;
}

test("the grid's Delete and bulk delete carry the warning, and the confirmation says it first (bo)", { skip }, async () => {
  const { default: AdminGridPage } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");
  const { DeleteRowButton } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/delete-button.tsx");
  const { BulkDeleteToolbar } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/bulk-toolbar.tsx");
  await withClient(async (c) => {
    const t = tag("ap-delwarn");
    const f = fixture(c, t);
    try {
      const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
      const phase = await f.row("phases", { label: `P ${code}`.slice(0, 24), sequence: 3_000_000 + Math.floor(Math.random() * 1e9) });
      const admin = await f.user("programme_admin", "pa");
      signIn({ id: admin, role: "programme_admin" });
      request.locale = "bo";
      request.cookies = { "gml-device": "desktop" };
      const tree = await AdminGridPage({
        params: Promise.resolve({ entity: "phases" }),
        searchParams: Promise.resolve({ "filter[label]": `P ${code}`.slice(0, 24) }),
      });
      const expected = deleteWarning(await translator("bo"), ADMIN_ENTITIES.phases!.table);
      assert.ok(expected, "deleting a phase unlinks teachers");
      const buttons = findAll(tree, DeleteRowButton);
      assert.ok(buttons.length >= 1, "the phase's Delete button");
      for (const b of buttons) assert.equal(b.props.warning, expected);
      const toolbars = findAll(tree, BulkDeleteToolbar);
      assert.equal(toolbars.length, 1);
      assert.equal(toolbars[0]!.props.warning, expected);
      // The page renders with it.
      await render(withAppRouter(tree));

      // The confirmation: the row, then what else goes, then "cannot be undone",
      // ON THE PAGE. It used to be window.confirm(), which a browser that
      // shows no dialogs (the desktop app's browser pane, some phones' in-app
      // browsers) answers "Cancel" at once: every Delete silently did
      // nothing (live QA, 9 Oct 2026). A dialog now fails this test.
      const g = globalThis as Record<string, unknown>;
      const had = "window" in g;
      const previous = g.window;
      g.window = {
        confirm: () => {
          throw new Error("window.confirm must not be used: some browsers never show it");
        },
      };
      let asked = "";
      try {
        const m = mount(DeleteRowButton as (p: unknown) => unknown, { entitySlug: "phases", rowId: phase, rowLabel: "P", warning: expected }, { intl: "bo" });
        (m.tree as El).props.onSubmit!.call(null, { preventDefault() {} } as never);
        const asking = m.rerender();
        asked = textOf(asking);
        const buttons = hostElements(asking).filter((e) => e.type === "button");
        const yes = buttons.find((b) => b.props["data-confirm-yes"] === "true");
        const cancel = buttons.find((b) => b.props["data-confirm-cancel"] === "true");
        assert.ok(yes && cancel, `the page itself must offer the choice:\n${asked}`);
        (cancel!.props.onClick as () => void)();
        const back = m.rerender();
        assert.ok(
          hostElements(back).some((e) => e.type === "form" && e.props["data-confirm-delete"] === "true"),
          "Cancel puts the Delete button back",
        );
      } finally {
        if (had) g.window = previous;
        else delete g.window;
      }
      assert.ok(asked.includes(expected!), `the confirmation did not carry the warning: ${asked}`);
      assert.ok(asked.indexOf(expected!) < asked.indexOf("འདི་ཕྱིར་ལྡོག་མི་ཐུབ།"), "what else goes is said before 'cannot be undone'");
      assert.equal((await c.query(`SELECT 1 FROM phases WHERE id = $1`, [phase])).rowCount, 1, "a declined confirmation deletes nothing");

      // A table whose delete changes nothing else keeps the plain confirmation.
      request.locale = "en";
      const zonesTree = await AdminGridPage({ params: Promise.resolve({ entity: "zones" }), searchParams: Promise.resolve({}) });
      for (const b of findAll(zonesTree, DeleteRowButton)) assert.equal(b.props.warning, undefined);
    } finally {
      request.locale = "en";
      signIn(null);
      await f.cleanup();
    }
  });
  void h;
});
