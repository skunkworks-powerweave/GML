// The admin dashboard's field map: markers that hydrate, name their school,
// and sit under their own district (F133).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
//   - `<title>{m.name} ({m.code})</title>` gave each marker's SVG title four
//     children. React's server renderer writes a <title> only when its child
//     is a single string, so the served HTML had `<title></title>` for every
//     school; the client rendered the text, hydration failed with React error
//     #418 on every admin load, and React discarded the server HTML. The
//     markers had no tooltip or accessible name in the page as served.
//   - The district was guessed from the school code -- "GMS-K", "GPS-K",
//     "GHS-K" meant Kargil. Codes name the place, not the district: GMS-KHA
//     (Khaltsi) is in Leh, and five of the six Kargil schools do not start with
//     a K. The dots were placed by a hash, anywhere across the KARGIL | LEH
//     halves the map draws under them.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The component rendered to static markup (the same server renderer whose
// empty <title> caused the mismatch), and the real dashboard rendered for an
// administrator against Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb } from "./_server-actions.js";
import { render, renderSync, h, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

/** Each marker: the school it links to, its colour, x, and its <title> text. */
function markers(html: string) {
  return [...html.matchAll(/<a href="\/repo\/school\/([^"]+)">([\s\S]*?)<\/a>/g)].map((m) => ({
    id: m[1]!,
    fill: m[2]!.match(/fill="([^"]*)"/)?.[1],
    cx: Number(m[2]!.match(/cx="([^"]*)"/)?.[1]),
    title: m[2]!.match(/<title>([\s\S]*?)<\/title>/)?.[1],
  }));
}

const DIVIDER_X = 280; // the dashed line between the KARGIL and LEH labels

test("each marker names its school and sits, coloured, under its own district", async () => {
  const { FieldMapSection } = await import("../../apps/web/src/app/(authenticated)/dashboard/FieldMap.tsx");
  const html = renderSync(
    h(FieldMapSection, {
      schools: [
        // Leh, although its code starts "GMS-K".
        { id: "s1", code: "GMS-KHA", name: "GMS Khaltsi", districtCode: "LEH" },
        // Kargil, although its code does not.
        { id: "s2", code: "GPS-SNK", name: "GPS Sankoo", districtCode: "KGL" },
        { id: "s3", code: "GHS-KGL", name: "GHS Kargil", districtCode: "KGL" },
        { id: "s4", code: "GHS-LEH", name: "GHS Leh", districtCode: "LEH" },
        // A district the map does not draw: neither colour, so it is not
        // claimed for either.
        { id: "s5", code: "GMS-NUB", name: "GMS Nubra", districtCode: "NUB" },
      ],
    }),
  );
  assert.doesNotMatch(html, /<title><\/title>/, "no empty marker title (the #418 hydration mismatch)");
  const by = new Map(markers(html).map((m) => [m.id, m]));
  assert.equal(by.get("s1")!.title, "GMS Khaltsi (GMS-KHA)");
  assert.equal(by.get("s2")!.title, "GPS Sankoo (GPS-SNK)");
  for (const id of ["s1", "s4"]) {
    assert.equal(by.get(id)!.fill, "var(--indigo)", `${id} is coloured Leh`);
    assert.ok(by.get(id)!.cx > DIVIDER_X, `${id} sits on the LEH side (cx ${by.get(id)!.cx})`);
  }
  for (const id of ["s2", "s3"]) {
    assert.equal(by.get(id)!.fill, "var(--saffron)", `${id} is coloured Kargil`);
    assert.ok(by.get(id)!.cx < DIVIDER_X, `${id} sits on the KARGIL side (cx ${by.get(id)!.cx})`);
  }
  assert.ok(!["var(--indigo)", "var(--saffron)"].includes(by.get("s5")!.fill ?? ""), "an undrawn district takes neither colour");
});

test("the real dashboard serves each school's marker with its title and its district's colour", { skip }, async () => {
  const w = await observationWorld("fieldmap");
  try {
    await w.grant(w.admin.id);
    signIn(w.admin);
    const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
    const html = await render(withAppRouter(await DashboardPage()));
    assert.doesNotMatch(html, /<title><\/title>/, "no empty marker title");
    const mine = markers(html).find((m) => m.id === w.schoolId);
    assert.ok(mine, "the world's school has a marker");
    assert.equal(mine.title, `School ${w.T} (${w.T.slice(-12)})`);
    // Its district (code ${T}) is neither Kargil nor Leh; the old code-prefix
    // rule called every non-"G?S-K" code Leh.
    assert.ok(!["var(--indigo)", "var(--saffron)"].includes(mine.fill ?? ""), `fill ${mine.fill}`);
  } finally {
    await w.cleanup();
  }
});
