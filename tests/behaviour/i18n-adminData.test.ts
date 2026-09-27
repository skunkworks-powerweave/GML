// The admin data grid, its import panel and the forms / quizzes / SCORM admin
// pages speak the user's language.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// Picking Hindi or Bhoti translated the menu and nothing on these pages. The
// grid's title, column headers, filters, buttons, empty states and refusals,
// the row form's labels and choices, the CSV import panel, and the forms,
// quizzes and SCORM registries were all English: the entity definitions
// carried English labels, and every sentence was written into the source.
// They now come from the adminData namespace (entity words under
// adminData.entities.<slug>, admin/labels.ts).
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real components and pages, rendered with next-intl's real provider for
// request.locale = "hi" and "bo"; each asserts a string from the bundle for
// that language is on the page and its English original is not. The server
// pages run against Postgres as a programme_admin; the client components need
// no database.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { h, render, renderSync, mount, withAppRouter, request, decodeEntities } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture } from "./_admin-fixture.js";
// _server-actions stubs auth() with its own session (signIn below), and closes
// the app pool the server pages open.
import { closeAppDb, signIn } from "./_server-actions.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const LOCALES = ["hi", "bo"] as const;
type Locale = (typeof LOCALES)[number];

/** A message from the real bundle, by dotted path ("adminData.grid.applyFilters"). */
function msg(locale: "en" | Locale, path: string): string {
  const value = path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], loadMessages(locale));
  assert.equal(typeof value, "string", `${locale}: ${path} is not a message`);
  return value as string;
}

/** The page's visible text, tags stripped and entities decoded. */
const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** `html` says the `locale` message at `path`, and not its English. */
function speaks(html: string, locale: Locale, path: string): void {
  const shown = text(html);
  assert.ok(shown.includes(msg(locale, path)), `${locale}: "${msg(locale, path)}" (${path}) is not on the page`);
  assert.ok(!shown.includes(msg("en", path)), `${locale}: the English "${msg("en", path)}" (${path}) is still on the page`);
}

/** The row form's entity words, resolved as the grid page does. */
async function formText(slug: string) {
  const { rowFormText } = await import("../../apps/web/src/admin/labels.ts");
  const { getTranslations } = await import("next-intl/server");
  return rowFormText((await getTranslations("adminData")) as never, ADMIN_ENTITIES[slug]!);
}

for (const locale of LOCALES) {
  test(`${locale}: the grid's row form -- its buttons, field labels and choices`, async () => {
    const { RowForm } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");
    request.locale = locale;
    try {
      const html = renderSync(h(RowForm as never, { entitySlug: "sessions", mode: "create", options: {}, text: await formText("sessions") } as never));
      speaks(html, locale, "adminData.client.rowForm.addRow");
      // An entity's words: a column header used as the form label, a label
      // only the form has, and an enum value by name.
      speaks(html, locale, "adminData.entities.sessions.columns.status");
      speaks(html, locale, "adminData.entities.sessions.fields.scheduledTime");
      speaks(html, locale, "adminData.entities.sessions.enum.status.cancelled");
      speaks(html, locale, "adminData.client.rowForm.yes");
    } finally {
      request.locale = "en";
    }
  });

  test(`${locale}: the CSV import panel`, async () => {
    const { ImportCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/import-csv.tsx");
    const { createRequire } = await import("node:module");
    const { AppRouterContext } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
      "next/dist/shared/lib/app-router-context.shared-runtime",
    ) as { AppRouterContext: { _currentValue: unknown } };
    const previous = AppRouterContext._currentValue;
    AppRouterContext._currentValue = (withAppRouter(null) as { props: { value: unknown } }).props.value;
    try {
      const m = mount(
        ImportCsv as (p: unknown) => unknown,
        { entitySlug: "schools", entityLabel: "S", acceptedColumns: ["name"], reportsDuplicates: true },
        { intl: locale },
      );
      const closed = renderSync(m.tree);
      speaks(closed, locale, "adminData.client.importCsv.open");
      // Open it: the heading, the explanation, the close button.
      (m.tree as { props: { onClick: () => void } }).props.onClick();
      const html = renderSync(m.rerender());
      speaks(html, locale, "adminData.client.importCsv.close");
      assert.ok(text(html).includes(msg(locale, "adminData.client.importCsv.title").replace("{entity}", "S")));
      assert.ok(!text(html).includes("Import into"), `${locale}: the panel's heading is still English`);
      assert.ok(!text(html).includes("Every row is validated"), `${locale}: the panel's explanation is still English`);
      assert.ok(!text(html).includes("unless it matches a record"), `${locale}: the duplicates clause is still English`);
    } finally {
      AppRouterContext._currentValue = previous;
    }
  });

  test(`${locale}: the phone card list's empty state`, async () => {
    const { MobileEntityCardList } = await import("../../apps/web/src/admin/components/MobileEntityCardList.tsx");
    request.locale = locale;
    try {
      const html = renderSync(
        h(MobileEntityCardList as never, { entitySlug: "zones", entityLabel: "Z", rows: [], columns: [{ key: "name", label: "N" }] } as never),
      );
      assert.ok(!text(html).includes("Use the form above to add one"), `${locale}: the empty state is still English`);
      assert.ok(text(html).includes(msg(locale, "adminData.client.mobileCards.empty").replace("{entity}", "z")));
    } finally {
      request.locale = "en";
    }
  });

  test(`${locale}: a zod refusal and a database refusal are said in the user's language`, async () => {
    const { issueLine } = await import("../../apps/web/src/admin/issues.ts");
    const { describeWriteError } = await import("../../apps/web/src/admin/db-errors.ts");
    const { getTranslations } = await import("next-intl/server");
    request.locale = locale;
    try {
      const t = (await getTranslations("adminData")) as never;
      const parsed = ADMIN_ENTITIES.districts!.formSchema.safeParse({ code: "X" });
      assert.equal(parsed.success, false);
      const line = issueLine(t, parsed.error!.issues[0]!);
      assert.ok(line.startsWith("name: "), line);
      assert.ok(line.includes(msg(locale, "adminData.zod.required")) && !line.includes("Required"), `${locale}: ${line}`);
      // An entity's own message is a key, said in the user's language.
      const phase = ADMIN_ENTITIES.phases!.formSchema.safeParse({ label: "P", sequence: 1, startDate: new Date("2026-10-01"), endDate: new Date("2026-09-01") });
      assert.equal(phase.success, false);
      assert.ok(issueLine(t, phase.error!.issues[0]!).includes(msg(locale, "adminData.validation.phaseEndsBeforeStart")));
      const dup = describeWriteError(t, ADMIN_ENTITIES.schools!, { code: "23505", detail: "Key (code)=(X) already exists." });
      assert.equal(dup.field, "code");
      assert.equal(dup.fieldMessage, msg(locale, "adminData.dbError.duplicate"));
    } finally {
      request.locale = "en";
    }
  });
}

test("hi and bo: the data grid, and the forms, quizzes and SCORM registries", { skip }, async () => {
  const { default: AdminGridPage } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");
  const { default: FormsPage } = await import("../../apps/web/src/app/(authenticated)/admin/forms/page.tsx");
  const { default: QuizzesPage } = await import("../../apps/web/src/app/(authenticated)/admin/quizzes/page.tsx");
  const { default: ScormPage } = await import("../../apps/web/src/app/(authenticated)/admin/scorm/page.tsx");
  await withClient(async (c) => {
    const t = tag("i18n-admin-data");
    const f = fixture(c, t);
    try {
      await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const admin = await f.user("programme_admin", "padmin");
      for (const locale of LOCALES) {
        signIn({ id: admin, role: "programme_admin" });
        request.locale = locale;
        request.cookies = { "gml-device": "desktop" };

        const grid = await render(
          withAppRouter(await AdminGridPage({ params: Promise.resolve({ entity: "districts" }), searchParams: Promise.resolve({}) })),
        );
        speaks(grid, locale, "adminData.entities.districts.label");
        speaks(grid, locale, "adminData.grid.applyFilters");
        speaks(grid, locale, "adminData.grid.addNew");
        speaks(grid, locale, "adminData.grid.exportCsv");
        speaks(grid, locale, "adminData.entities.districts.columns.createdAt");
        assert.ok(text(grid).includes(`D ${t}`), "the district's name is data, shown as stored");

        // A filter that cannot apply is explained in the user's language.
        const filtered = await render(
          withAppRouter(
            await AdminGridPage({ params: Promise.resolve({ entity: "districts" }), searchParams: Promise.resolve({ "filter[createdAt]": "soon" }) }),
          ),
        );
        speaks(filtered, locale, "adminData.grid.skip.notDate");

        const forms = await render(withAppRouter(await FormsPage()));
        speaks(forms, locale, "adminData.forms.title");
        speaks(forms, locale, "adminData.forms.intro");

        const quizzes = await render(withAppRouter(await QuizzesPage()));
        speaks(quizzes, locale, "adminData.quizzes.title");
        speaks(quizzes, locale, "adminData.client.newQuiz.open");

        const scorm = await render(withAppRouter(await ScormPage()));
        speaks(scorm, locale, "adminData.scorm.intro");
        speaks(scorm, locale, "adminData.scorm.uploadOnlySuper");
      }
    } finally {
      signIn(null);
      await f.cleanup();
    }
  });
});
