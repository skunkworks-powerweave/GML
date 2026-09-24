// Where does each row on /forms send its user? EXECUTED -- no database needed.
//
// A mentorship form is answered AGAINST A PAIRING: submitFormAction refuses a
// submission with no pairingId. The catalogue used to link
//   one pairing   -> /forms/<slug>?pairingId=<id>
//   admin         -> /forms/<slug>
//   anyone else   -> /inbox
// and "anyone else" was every mentor with two or more mentees -- the normal
// case; the shipped seed gives both mentors five. /inbox has no feedback-form
// card at all, so every row on the page dropped the mentor on their
// notification feed with no form and no explanation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formCatalogueLinks,
  MAX_PAIRING_LINKS,
  type PairingChoice,
} from "../../apps/web/src/lib/forms/catalogue-links.ts";

const SLUG = "baseline-mentor-1";
const pairing = (n: number, active = true): PairingChoice => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  label: `Mentee ${n}`,
  active,
});

test("a mentor with several mentees gets one working link per mentee, not /inbox", () => {
  const links = formCatalogueLinks(SLUG, { isAdmin: false, pairings: [pairing(1), pairing(2), pairing(3)] });
  assert.deepEqual(
    links.map((l) => l.href),
    [1, 2, 3].map((n) => `/forms/${SLUG}?pairingId=${pairing(n).id}`),
  );
  assert.deepEqual(
    links.map((l) => l.label),
    ["Mentee 1", "Mentee 2", "Mentee 3"],
    "each link must say whose form it is",
  );
  for (const l of links) assert.notEqual(l.href, "/inbox");
});

test("the chooser is capped, and the overflow goes to the pairing list", () => {
  const many = Array.from({ length: MAX_PAIRING_LINKS + 4 }, (_, i) => pairing(i + 1));
  const links = formCatalogueLinks(SLUG, { isAdmin: false, pairings: many });
  assert.equal(links.length, MAX_PAIRING_LINKS + 1);
  assert.ok(links.slice(0, MAX_PAIRING_LINKS).every((l) => l.href.includes("?pairingId=")));
  const more = links[MAX_PAIRING_LINKS]!;
  assert.equal(more.href, "/mentorship", "every pairing page carries its own per-quarter form links");
  assert.match(more.label ?? "", new RegExp(String(many.length)));
});

test("a single pairing links straight to its form", () => {
  const links = formCatalogueLinks(SLUG, { isAdmin: false, pairings: [pairing(7)] });
  assert.deepEqual(links.map((l) => l.href), [`/forms/${SLUG}?pairingId=${pairing(7).id}`]);
});

test("an administrator previews the form itself", () => {
  const links = formCatalogueLinks(SLUG, { isAdmin: true, pairings: [] });
  assert.deepEqual(links.map((l) => l.href), [`/forms/${SLUG}`]);
});

test("no pairing means no link -- never a dead end", () => {
  // The page shows the "not part of a pairing yet" banner for this case.
  assert.deepEqual(formCatalogueLinks(SLUG, { isAdmin: false, pairings: [] }), []);
});

test("if the pairing lookup failed, the fallback is the pairing list, not /inbox", () => {
  const links = formCatalogueLinks(SLUG, { isAdmin: false, pairings: [], lookupFailed: true });
  assert.deepEqual(links.map((l) => l.href), ["/mentorship"]);
});

test("pairing ids are URL-encoded into the link", () => {
  const odd: PairingChoice = { id: "a b&c", label: "x", active: true };
  const [l] = formCatalogueLinks(SLUG, { isAdmin: false, pairings: [odd] });
  assert.equal(l!.href, `/forms/${SLUG}?pairingId=a%20b%26c`);
});
