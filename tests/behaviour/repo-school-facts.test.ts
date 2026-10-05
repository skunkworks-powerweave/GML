// A school's page says what the school's row says, and nothing else.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// Every school page -- including the one for a school added a minute ago --
// opened with the same fixed sentence: "Government school under SCERT Ladakh,
// partnered with the programme since 2024." It sat in the translation as part of
// the page's intro, so it was printed for a private school, for one that joined
// last month and for one the programme has not yet reached. Nothing in the
// database holds any of it. (Found in the 5 Oct 2026 QA of the admin flows.)
//
// ── WHAT IS EXECUTED ───────────────────────────────────────────────────────
//
// The real /repo/school/[id] page, as a programme admin, in English, Hindi and
// Bhoti, against Postgres: for a school with an address and for one with
// nothing but a name, a code and a zone. The line under the title names the
// zone and district the row sits in; the address is shown when there is one;
// the claim is gone from the page and from every bundle.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, request, decodeEntities, withAppRouter } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/repo";
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

async function schoolPage(world: Awaited<ReturnType<typeof observationWorld>>, schoolId: string, locale: "en" | "hi" | "bo"): Promise<string> {
  const { default: School } = await import(`${APP}/school/[id]/page.tsx`);
  signIn({ id: world.admin.id, role: "programme_admin", name: world.admin.name, email: world.admin.email });
  request.locale = locale;
  try {
    return text(await render(withAppRouter(await School({ params: Promise.resolve({ id: schoolId }) }))));
  } finally {
    request.locale = "en";
  }
}

// What the fixed sentence said, in each language.
const CLAIMS = [/SCERT/, /partnered with the programme/i, /since 2024/i, /Government school/i, /सरकारी विद्यालय/, /सहभागी/, /ལས་གཞི་དང་མཉམ་འབྲེལ་བྱས་ཡོད/];

test("a school's page shows its zone and district and its address, and makes no claim the row does not hold", { skip }, async () => {
  const w = await observationWorld("schoolfacts");
  let bareSchool = "";
  try {
    await w.c.query(`UPDATE schools SET address = $1 WHERE id = $2`, ["Main Bazaar, Leh 194101", w.schoolId]);
    const zoneId = (await w.c.query(`SELECT zone_id FROM schools WHERE id = $1`, [w.schoolId])).rows[0].zone_id as string;
    // A school added a minute ago: a name, a code and a zone, nothing else.
    bareSchool = (
      await w.c.query(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [zoneId, `Bare School ${w.T}`, `B${w.T.slice(-10)}`])
    ).rows[0].id as string;

    for (const locale of ["en", "hi", "bo"] as const) {
      for (const id of [w.schoolId, bareSchool]) {
        const page = await schoolPage(w, id, locale);
        for (const claim of CLAIMS) assert.doesNotMatch(page, claim, `${locale}: the page still carries a fixed claim (${claim})`);
        assert.ok(page.includes(`Zone ${w.T}`) && page.includes(`District ${w.T}`), `${locale}: the zone and district of the row are shown`);
      }
    }

    const withAddress = await schoolPage(w, w.schoolId, "en");
    assert.match(withAddress, new RegExp(`Zone ${w.T}, District ${w.T} district\\.`), "the line under the title is the row's place");
    assert.match(withAddress, /Address Main Bazaar, Leh 194101/, "the address, labelled, in the details");
    assert.match(await schoolPage(w, w.schoolId, "hi"), /पता Main Bazaar, Leh 194101/);
    assert.match(await schoolPage(w, w.schoolId, "bo"), /ཁ་བྱང་། Main Bazaar, Leh 194101/);

    // No address on the row: no address row, and no empty placeholder for it.
    const bare = await schoolPage(w, bareSchool, "en");
    assert.doesNotMatch(bare, /Address/, "a school with no address has no Address row");
    assert.match(bare, new RegExp(`Bare School ${w.T}`));
  } finally {
    if (bareSchool) await w.c.query(`DELETE FROM schools WHERE id = $1`, [bareSchool]);
    await w.cleanup();
  }
});

test("no bundle carries the fixed claim any more", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "web", "src", "i18n", "locales");
  const hits: string[] = [];
  for (const locale of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const file of readdirSync(resolve(root, locale.name))) {
      const body = readFileSync(resolve(root, locale.name, file), "utf8");
      if (/partnered with the programme|2024 से कार्यक्रम का सहभागी|ལས་གཞི་དང་མཉམ་འབྲེལ་བྱས་ཡོད/.test(body)) hits.push(`${locale.name}/${file}`);
    }
  }
  assert.deepEqual(hits, []);
});
