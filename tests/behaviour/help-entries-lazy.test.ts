// The help articles reach the browser when the panel opens, not with every page.
//
// They are most of the help namespace: every article, and in Hindi or Bhoti
// three bytes a character. They used to be part of the strings every page
// hands the browser (clientMessages), ~56 KB raw in Bhoti on each first load,
// for a panel most visits never open. Now the panel asks for them the first
// time it opens (components/help/entries.ts, useHelpEntries) and keeps them.
//
// Executed: the real HelpPanel under mount() with its effects, the real server
// action, the real bundles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount, textOf } from "./_ui.js";
import { clientMessages, loadMessages } from "../../apps/web/src/i18n/config.ts";

test("the browser's strings carry no help article", () => {
  for (const locale of ["en", "hi", "bo"] as const) {
    const help = clientMessages(locale).help as Record<string, unknown>;
    assert.ok(help.client, `${locale}: the panel's own words are sent`);
    assert.equal((help.client as Record<string, unknown>).entries, undefined, `${locale}: no article rides along`);
    assert.equal(help.entries, undefined);
  }
});

test("the panel fetches the articles on first open, in the reader's language", async () => {
  const { HelpPanel, HELP_OPEN_EVENT } = await import("../../apps/web/src/components/help/HelpPanel.tsx");
  const g = globalThis as Record<string, unknown>;
  const hadDocument = "document" in g;
  const previousDocument = g.document;
  const hadWindow = "window" in g;
  const previousWindow = g.window;
  // A window for the whole test (withFakeWindow restores it at the first await).
  const win = Object.assign(new EventTarget(), { location: { pathname: "/observation" } });
  g.window = win;
  g.document = { activeElement: null };
  try {
    // Bhoti: nothing primed, so this is the real fetch through the server action.
    const locale = "bo";
    const help = loadMessages(locale).help as unknown as {
      entries: Record<string, { title: string; long: string }>;
      client: { panel: { loading: string } };
    };
    {
      const m = mount(HelpPanel as (p: unknown) => unknown, { contact: { whatsappPhone: null, email: null } }, { effects: true, intl: locale });
      win.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT, { detail: { topic: "cycle" } }));
      const first = textOf(m.rerender());
      assert.ok(first.includes(help.client.panel.loading), `while loading it says so: ${first}`);
      assert.ok(!first.includes(help.entries.cycle.title), "no article before it arrives");

      // Let the server action's promise settle, then render as React would.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const shown = textOf(m.rerender());
      assert.ok(shown.includes(help.entries.cycle.title), `the article arrives in Bhoti: ${shown}`);
      assert.ok(shown.includes(help.entries.cycle.long));
      m.unmount();
    }
  } finally {
    if (hadDocument) g.document = previousDocument;
    else delete g.document;
    if (hadWindow) g.window = previousWindow;
    else delete g.window;
  }
});
