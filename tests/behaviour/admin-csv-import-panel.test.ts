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
    const m = mount(ImportCsv as (p: unknown) => unknown, { entitySlug: "schools", entityLabel: "Schools", acceptedColumns: ["name"] }, { intl: "en" });
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
    const m = mount(ImportCsv as (p: unknown) => unknown, { entityLabel: "Table", acceptedColumns: ["name"], ...props }, { intl: "en" });
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

// ── D-7d: after an import the panel does not offer the same rows again ───────
//
// The panel kept the chosen file, its preview and a live "Import N rows"
// button after the import finished, so the obvious next click sent the same
// rows a second time. A finished import now clears the file and the preview and
// leaves the result on screen; the operator picks a file again to import
// another. A request that did not get an answer keeps the file, so it can be
// retried.

/**
 * Drive the real panel through open -> pick -> import against a stubbed import
 * route, then hand `check` the panel as the operator now sees it.
 */
async function importThrough(
  respond: () => Response | Promise<Response>,
  check: (run: {
    beforeImport: { panel: string; disabled: boolean };
    panel: () => string;
    submit: () => { props: Record<string, unknown> };
    result: () => string | null;
    pressSubmit: () => Promise<void>;
    calls: () => number;
  }) => Promise<void>,
) {
  const { ImportCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/import-csv.tsx");
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return respond();
  }) as typeof fetch;
  const { AppRouterContext } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } };
  const previous = AppRouterContext._currentValue;
  AppRouterContext._currentValue = (withAppRouter(null) as { props: { value: unknown } }).props.value;
  try {
    const m = mount(ImportCsv as (p: unknown) => unknown, { entitySlug: "schools", entityLabel: "Schools", acceptedColumns: ["name"] }, { intl: "en" });
    const find = (id: string) => hostElements(m.tree).find((el) => el.props["data-testid"] === id);
    const press = async (id: string) => {
      await (find(id)!.props.onClick as () => Promise<void> | void)();
      m.rerender();
    };
    (find("import-csv-open")!.props.onClick as () => void)();
    m.rerender();
    await (find("import-csv-file")!.props.onChange as (e: unknown) => Promise<void>)({
      target: { files: [{ name: "s.csv", text: async () => "name\nok\nsecond\n" }] },
    });
    m.rerender();
    const beforeImport = { panel: textOf(find("import-csv-panel")), disabled: find("import-csv-submit")!.props.disabled as boolean };
    await press("import-csv-submit");
    await check({
      beforeImport,
      panel: () => textOf(find("import-csv-panel")),
      submit: () => find("import-csv-submit")!,
      result: () => (find("import-csv-result") ? textOf(find("import-csv-result")) : null),
      pressSubmit: () => press("import-csv-submit"),
      calls: () => calls,
    });
  } finally {
    globalThis.fetch = realFetch;
    AppRouterContext._currentValue = previous;
  }
}

test("a finished import clears the file and its preview, shows the result, and no longer offers the rows", async () => {
  await importThrough(
    () => new Response(JSON.stringify({ ok: true, inserted: 2, skipped: 0, errors: [] }), { status: 200 }),
    async (run) => {
      assert.match(run.beforeImport.panel, /s\.csv/, "the file was shown before the import");
      assert.match(run.beforeImport.panel, /Import 2 rows/);
      assert.equal(run.beforeImport.disabled, false, "and the button was live");

      assert.doesNotMatch(run.panel(), /s\.csv/, "the chosen file is cleared");
      assert.doesNotMatch(run.panel(), /2 data rows/, "and so is its preview");
      assert.doesNotMatch(run.panel(), /Import 2 rows/, "the button no longer names the rows just imported");
      assert.equal(run.submit().props.disabled, true, "nothing is left to import");
      assert.match(run.result() ?? "", /2 inserted/, "the result stays on screen");

      await run.pressSubmit(); // a click that still reaches the handler sends nothing
      assert.equal(run.calls(), 1, "the same rows were not sent again");
    },
  );
});

test("a partly failed import clears the file too, and keeps its row-by-row report", async () => {
  await importThrough(
    () => new Response(JSON.stringify({ ok: false, inserted: 1, skipped: 1, errors: [{ row: 3, message: "name: too short" }] }), { status: 207 }),
    async (run) => {
      assert.doesNotMatch(run.panel(), /s\.csv/);
      assert.equal(run.submit().props.disabled, true);
      assert.match(run.result() ?? "", /Row 3: name: too short/);
      // The edited file has to be chosen again: the one in the box was read before the fix.
      await run.pressSubmit();
      assert.equal(run.calls(), 1);
    },
  );
});

// The import route also answers 207 when the server could not do the work at
// all -- the connection or the transaction failed, and "Nothing was saved" --
// reporting it against no row (row -1). That is the same case as a request that
// got no answer: no rows landed, the file is fine, and a plain retry is the
// right next move. Clearing the file there made the operator pick it again.
test("an import the server could not complete keeps the file, so the operator can try again", async () => {
  await importThrough(
    () =>
      new Response(
        JSON.stringify({ ok: false, inserted: 0, updated: 0, skipped: 2, errors: [{ row: -1, message: "The import could not be completed. Nothing was saved." }] }),
        { status: 207 },
      ),
    async (run) => {
      assert.match(run.panel(), /s\.csv/, "the file is still chosen");
      assert.match(run.panel(), /Import 2 rows/, "and still names its rows");
      assert.equal(run.submit().props.disabled, false, "and the button still works");
      assert.match(run.result() ?? "", /Nothing was saved/, "the failure is shown");
      await run.pressSubmit();
      assert.equal(run.calls(), 2, "a retry is sent");
    },
  );
});

test("an import that refused every row still clears the file: it has to be fixed before it is chosen again", async () => {
  await importThrough(
    () =>
      new Response(
        JSON.stringify({ ok: false, inserted: 0, updated: 0, skipped: 2, errors: [{ row: 2, message: "name: too short" }, { row: 3, message: "name: too short" }] }),
        { status: 207 },
      ),
    async (run) => {
      assert.doesNotMatch(run.panel(), /s\.csv/);
      assert.equal(run.submit().props.disabled, true);
      assert.match(run.result() ?? "", /Row 3: name: too short/);
      await run.pressSubmit();
      assert.equal(run.calls(), 1);
    },
  );
});

test("an import that got no answer keeps the file, so the operator can try again", async () => {
  await importThrough(
    () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    async (run) => {
      assert.match(run.panel(), /s\.csv/, "the file is still chosen");
      assert.equal(run.submit().props.disabled, false, "and the button still works");
      assert.equal(run.result(), null);
      await run.pressSubmit();
      assert.equal(run.calls(), 2, "a retry is sent");
    },
  );
});
