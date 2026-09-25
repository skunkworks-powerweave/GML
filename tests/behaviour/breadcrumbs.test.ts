// The breadcrumb trail links only to pages that exist, and every parent that
// is a page is a link.
//
// ── THE DEFECT (F131) ────────────────────────────────────────────────────────
//
// buildCrumbs() guessed whether a parent path was a page from the shape of
// the NEXT segment: a uuid or a number meant "not a page", anything else meant
// "page". Wrong both ways. /admin/data, /quizzes and /rtt/online hold only a
// [entity] / [slug] / (a)synchronous child and have no page.tsx, yet were
// linked -- "Data tables" on /admin/data/teachers, the main admin surface,
// was a 404 -- while /videos, /observation, /mentorship, /admin/forms,
// /admin/quizzes and the /repo/class|resource/<id> "Details" crumbs are real
// pages that were shown as plain text because a uuid followed them.
//
// Executed: the real buildCrumbs, for every page under app/(authenticated),
// with the route list read from the directory tree itself -- so a route
// added later is checked without anyone remembering to add it here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SRC_DIR } from "./_ui.js";

const APP = join(SRC_DIR, "app", "(authenticated)");

/** Every page route under app/(authenticated), as "/a/[b]/c". */
function pageRoutes(dir = APP, prefix = ""): string[] {
  const out: string[] = [];
  if (existsSync(join(dir, "page.tsx")) && prefix) out.push(prefix);
  for (const name of readdirSync(dir)) {
    if (statSync(join(dir, name)).isDirectory()) out.push(...pageRoutes(join(dir, name), `${prefix}/${name}`));
  }
  return out;
}

const UUID = "0c7ce1a2-12e4-4839-8f46-a57bfad08006";
const SAMPLE: Record<string, string> = { slug: "audit-ux-quiz", entity: "teachers" };
const fill = (route: string) => route.replace(/\[([^\]]+)\]/g, (_, p: string) => SAMPLE[p] ?? UUID);

const ROUTES = pageRoutes();
const PATTERNS = ROUTES.map((r) => new RegExp(`^${r.replace(/\[[^\]]+\]/g, "[^/]+")}$`));
const isPage = (path: string) => PATTERNS.some((re) => re.test(path));

test("F131: the route list the breadcrumbs link against is the app's real one", async () => {
  const { ROUTABLE } = await import("../../apps/web/src/components/nav/Breadcrumbs.tsx");
  assert.deepEqual([...ROUTABLE].sort(), [...ROUTES].sort(), "Breadcrumbs.ROUTABLE must list exactly the pages in app/(authenticated)");
});

test("F131: every crumb links exactly when its path is a page, and the current page never does", async () => {
  const { buildCrumbs } = await import("../../apps/web/src/components/nav/Breadcrumbs.tsx");
  const wrong: string[] = [];
  for (const route of ROUTES) {
    const path = fill(route);
    const segments = path.split("/").filter(Boolean);
    const crumbs = buildCrumbs(path);
    assert.equal(crumbs.length, segments.length, `${path}: one crumb per segment`);
    crumbs.forEach((c, i) => {
      const at = "/" + segments.slice(0, i + 1).join("/");
      const last = i === crumbs.length - 1;
      const expected = !last && isPage(at) ? at : null;
      if (c.href !== expected) wrong.push(`${path}: "${c.label}" links to ${c.href ?? "nothing"}, should ${expected ? `link to ${expected}` : "not link"}`);
    });
  }
  assert.deepEqual(wrong, [], "crumbs that 404 or hide a real page");
});

test("F131: the cases the audit reported", async () => {
  const { buildCrumbs } = await import("../../apps/web/src/components/nav/Breadcrumbs.tsx");
  assert.equal(buildCrumbs("/admin/data/teachers")[1].href, null, "/admin/data is not a page");
  assert.equal(buildCrumbs("/admin/data/teachers")[0].href, "/admin");
  assert.equal(buildCrumbs("/quizzes/audit-ux-quiz/history")[0].href, null, "/quizzes is not a page");
  assert.equal(buildCrumbs("/quizzes/audit-ux-quiz/history")[1].href, "/quizzes/audit-ux-quiz");
  assert.equal(buildCrumbs("/rtt/online/synchronous")[1].href, null, "/rtt/online is not a page");
  assert.equal(buildCrumbs(`/videos/${UUID}`)[0].href, "/videos", "the Video library is a page");
  assert.equal(buildCrumbs(`/repo/class/${UUID}/learners`)[2].href, `/repo/class/${UUID}`, "the class it belongs to is a page");
  assert.equal(buildCrumbs(`/repo/class/${UUID}/learners`)[1].href, null, "/repo/class is not");
});
