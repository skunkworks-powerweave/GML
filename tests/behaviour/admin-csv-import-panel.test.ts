// The import panel names the spreadsheet line the server reported.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// importCsv already reports each failure by its spreadsheet line (header =
// line 1, first data row = line 2). The panel added 2 again -- `Row
// ${e.row + 2}` -- so an operator fixing a 400-row file was sent two lines too
// far for every error.
//
// Executed: the real ImportCsv client component, driven through its own
// handlers with mount() (see _ui.ts), against a stubbed fetch that answers as
// the import route does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mount, hostElements, textOf, withAppRouter } from "./_ui.js";

test("the import panel shows the spreadsheet line the server reported", async () => {
  const { ImportCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/import-csv.tsx");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, inserted: 1, skipped: 1, errors: [{ row: 3, message: "name: too short" }] }), {
      status: 207,
    })) as typeof fetch;
  // useRouter needs the app-router context. mount() reads a context's current
  // value directly, so give it the router object withAppRouter would provide.
  const { AppRouterContext } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } };
  const previous = AppRouterContext._currentValue;
  AppRouterContext._currentValue = (withAppRouter(null) as { props: { value: unknown } }).props.value;
  try {
    const m = mount(ImportCsv as (p: unknown) => unknown, { entitySlug: "schools", entityLabel: "Schools", acceptedColumns: ["name"] });
    const find = (id: string) => hostElements(m.tree).find((el) => el.props["data-testid"] === id)!;
    (find("import-csv-open").props.onClick as () => void)();
    m.rerender();
    await (find("import-csv-file").props.onChange as (e: unknown) => Promise<void>)({
      target: { files: [{ name: "s.csv", text: async () => "name\nok\nx\n" }] },
    });
    m.rerender();
    await (find("import-csv-submit").props.onClick as () => Promise<void>)();
    m.rerender();
    const text = textOf(find("import-csv-result"));
    assert.match(text, /Row 3: name: too short/, `the panel showed: ${text}`);
  } finally {
    globalThis.fetch = realFetch;
    AppRouterContext._currentValue = previous;
  }
});

// The panel said only that "a row without [an id] is added". After a partial
// import, the natural next step -- fix the failed rows and upload the whole
// file again -- then added every row that had landed a second time. The
// importer now reports those rows instead (admin-csv-upsert.test.ts), and the
// panel says so before the operator picks the file.
test("the import panel says what re-uploading a file does with rows that already landed", async () => {
  const { ImportCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/import-csv.tsx");
  const { AppRouterContext } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } };
  const previous = AppRouterContext._currentValue;
  AppRouterContext._currentValue = (withAppRouter(null) as { props: { value: unknown } }).props.value;
  const panelText = (props: Record<string, unknown>) => {
    const m = mount(ImportCsv as (p: unknown) => unknown, { entityLabel: "Table", acceptedColumns: ["name"], ...props });
    (hostElements(m.tree).find((el) => el.props["data-testid"] === "import-csv-open")!.props.onClick as () => void)();
    m.rerender();
    return textOf(hostElements(m.tree).find((el) => el.props["data-testid"] === "import-csv-panel")!);
  };
  try {
    // The page passes reportsDuplicates for an entity with a duplicateKey.
    const roster = panelText({ entitySlug: "teachers", reportsDuplicates: true });
    assert.match(roster, /matches a record already on the table: that row is reported, not added again/, `the panel said: ${roster}`);
    assert.match(roster, /After a partial import, import again only the rows reported as failed/);
    // A table without that check is not promised it.
    const other = panelText({ entitySlug: "sessions" });
    assert.doesNotMatch(other, /already on the table/);
    assert.match(other, /After a partial import, import again only the rows reported as failed/);
  } finally {
    AppRouterContext._currentValue = previous;
  }
});
