// A form's own Hindi title is shown to a Hindi reader.
//
// The seeded forms carry their Hindi title (titleHindi) for exactly this, and
// nothing read it: the /forms catalogue, the runner and the thanks page showed
// the English title in every language. ownFormTitle now prefers it for "hi"
// (also under FormRenderer's spelling, hindiTitle) and falls back to the
// English title; Bhoti readers get the English title until forms carry a
// Bhoti one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formTitle, ownFormTitle } from "../../apps/web/src/lib/forms/quarterly.ts";

const seeded = { title: "Progress check 1 — Teacher reflection", titleHindi: "प्रगति जाँच 1 — शिक्षक चिंतन" };

test("a Hindi reader gets the form's Hindi title; others get the English one", () => {
  assert.equal(ownFormTitle(seeded, "hi"), seeded.titleHindi);
  assert.equal(ownFormTitle({ title: "X", hindiTitle: "एक्स" }, "hi"), "एक्स");
  assert.equal(ownFormTitle(seeded, "en"), seeded.title);
  assert.equal(ownFormTitle(seeded, "bo"), seeded.title);
  assert.equal(ownFormTitle(seeded), seeded.title);
  assert.equal(ownFormTitle({ title: "Only English" }, "hi"), "Only English", "no Hindi title: the English one");
  assert.equal(ownFormTitle({ titleHindi: "  " }, "hi"), null, "a blank title is no title");
});

test("formTitle passes the reader's language through", () => {
  const t = (key: string, v: Record<string, string>) => `${key}:${v.kind}/${v.audience}`;
  assert.equal(formTitle(seeded, "progress_1", "mentee", t, "hi"), seeded.titleHindi);
  assert.equal(formTitle({}, "baseline", "mentor", t, "hi"), "formTitle:baseline/mentor");
});
