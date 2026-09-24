import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX = "apps/web/src/app/(authenticated)/repo/mentors/page.tsx";
const DETAIL = "apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx";

test("spec 053: repo mentors index + detail routes exist", () => {
  assert.ok(existsSync(resolve(root, INDEX)), `${INDEX} must exist`);
  assert.ok(existsSync(resolve(root, DETAIL)), `${DETAIL} must exist`);
});

test("spec 053: routes are server components with force-dynamic + auth guard", () => {
  for (const p of [INDEX, DETAIL]) {
    const src = read(p);
    assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/, `${p} must be force-dynamic`);
    assert.match(src, /from\s+"@\/auth"/, `${p} must import auth()`);
    assert.match(src, /auth\(\)/, `${p} must call auth()`);
    assert.match(src, /redirect\("\/login"\)/, `${p} must redirect to /login on no session`);
  }
});

test("spec 053: routes query Drizzle against mentors + mentorPairings", () => {
  const indexSrc = read(INDEX);
  assert.match(indexSrc, /from\s+"@gml\/db"/);
  assert.match(indexSrc, /from\s+"@gml\/db\/schema"/);
  assert.match(indexSrc, /\bmentors\b/);
  assert.match(indexSrc, /\bmentorPairings\b/);
  // Active-only listing + mentee count groupBy
  assert.match(indexSrc, /eq\(mentors\.active,\s*true\)/);
  assert.match(indexSrc, /groupBy\(mentorPairings\.mentorId\)/);
  assert.match(indexSrc, /eq\(mentorPairings\.status,\s*"active"\)/);

  const detailSrc = read(DETAIL);
  assert.match(detailSrc, /from\s+"@gml\/db"/);
  assert.match(detailSrc, /from\s+"@gml\/db\/schema"/);
  assert.match(detailSrc, /\bmentors\b/);
  // The pairing roster is mentorship-section data. It is read through
  // lib/gated-reads under the viewer's mentorship access (section password +
  // visibility predicate), not by a select written here -- the page used to
  // serve it without the password. Executed in tests/behaviour/access-control.
  assert.match(detailSrc, /mentorRoster\(\s*db\s*,\s*mentorship\s*,\s*id\s*\)/);
  assert.match(detailSrc, /mentorshipAccess\(\s*db\s*,\s*actor\s*\)/);
});

test("spec 053: index ports JSX columns Name / नाम / Expertise / Based in / Mentees", () => {
  const src = read(INDEX);
  for (const header of [">Name<", ">नाम<", ">Expertise<", ">Based in<", ">Mentees<"]) {
    assert.ok(src.includes(header), `index must render header ${header}`);
  }
  assert.match(src, /Master mentors carrying 5 mentees each through quarterly progress checks\./);
});

test("spec 053: Hindi name renders only when present (SM-7) using Devanagari font", () => {
  for (const p of [INDEX, DETAIL]) {
    const src = read(p);
    assert.match(src, /var\(--deva\)/, `${p} must use Devanagari font token for Hindi`);
    assert.match(src, /hindiName/, `${p} must reference hindiName field`);
  }
});

test("spec 053: detail groups pairings by all five pairing statuses", () => {
  const src = read(DETAIL);
  for (const status of ["active", "review", "paused", "complete", "ended"]) {
    assert.match(src, new RegExp(`"${status}"`), `detail must reference status ${status}`);
  }
  // Status-coloured pills + quarter chip + meetings count
  assert.match(src, /currentQuarter/);
  assert.match(src, /meetingsCount/);
  assert.match(src, /lastMeetingAt/);
});

test("spec 053: base-location chip uses indigo for Leh and saffron for Kargil", () => {
  const src = read(INDEX);
  assert.match(src, /Leh.*indigo-soft/s);
  assert.match(src, /Kargil.*saffron-soft/s);
});

test("spec 053: detail card links to /mentorship/<pairingId>", () => {
  const src = read(DETAIL);
  assert.match(src, /href=\{`\/mentorship\/\$\{p\.id\}`\}/);
});

test("spec 053: index row links to /repo/mentor/<id>", () => {
  const src = read(INDEX);
  assert.match(src, /href=\{`\/repo\/mentor\/\$\{m\.id\}`\}/);
});
