// Who has done a SCORM module, and how well: the staff pages, and the
// learner's own card on the RTT subject page -- real pages against Postgres.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - /admin/scorm lists every package with how many learners have a record
//     and how many finished; /admin/scorm/[id] lists each learner's status,
//     score, time and first completion. Administrators only.
//   - An administrator can withdraw a package (learners stop seeing it; their
//     records stay) and restore it; both are audited and documented.
//   - The RTT subject page lists the subject's packages the learner may
//     launch, with her own status and a Start / Resume / Review link to
//     /scorm/<id>. A withdrawn package is not offered.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { render, withAppRouter, elements, openingTags, attr } from "./_ui.js";
import { signIn, closeAppDb, outcome, form } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

async function withTracked(body: (x: { w: RttWorld; subjectId: string; pkgId: string; other: { id: string; name: string } }) => Promise<void>) {
  const w = await rttWorld("scsf");
  try {
    const { insertPackage, commitAttempt } = await import("../../apps/web/src/lib/scorm/store.ts");
    const db = drizzle(w.c);
    const subjectId = await w.subject({ zoneId: w.zoneId });
    const pkgId = randomUUID();
    await insertPackage(db, {
      id: pkgId,
      rttSubjectId: subjectId,
      title: `Phonics ${w.T}`,
      manifestIdentifier: "x",
      launchPath: "index.html",
      launchQuery: "",
      masteryScore: null,
      launchData: null,
      uploadedByUserId: w.admin.id,
      totalBytes: 2 * 1024 * 1024,
      files: [{ path: "index.html", objectKey: `${pkgId}/0`, sizeBytes: 10 }],
    });
    const other = await w.addTeacher("Zara");
    const commit = (userId: string, lessonStatus: "passed" | "incomplete", scoreRaw: number | null, sessionTimeCs: number) =>
      commitAttempt(db, userId, pkgId, {
        sessionId: randomUUID(),
        lessonStatus,
        lessonLocation: "",
        scoreRaw,
        scoreMin: null,
        scoreMax: null,
        suspendData: "",
        exit: "",
        sessionTimeCs,
      });
    await commit(w.teacher.id, "passed", 72.5, 5 * 60 * 100 + 4000 * 100);
    await commit(other.user.id, "incomplete", null, 1500);
    await body({ w, subjectId, pkgId, other: { id: other.user.id, name: other.user.name } });
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

const rows = (html: string) => elements(html, "tr").map((r) => r.text.replace(/\s+/g, " ").trim());

test("the tracking page shows each learner's status, score, time and completion, to administrators only", { skip }, async () => {
  await withTracked(async ({ w, pkgId, other }) => {
    const { default: TrackingPage } = await import("../../apps/web/src/app/(authenticated)/admin/scorm/[id]/page.tsx");
    const page = (id: string) => TrackingPage({ params: Promise.resolve({ id }) });

    signIn(w.admin);
    const html = await render(withAppRouter(await page(pkgId)));
    const mine = rows(html).find((r) => r.includes(w.teacher.name));
    assert.ok(mine, "the learner who passed is listed");
    assert.match(mine!, /Passed/);
    assert.match(mine!, /72\.5/);
    assert.match(mine!, /1 h 11 min/, "5 min + 4000 s of time, summed");
    const theirs = rows(html).find((r) => r.includes(other.name));
    assert.match(theirs!, /In progress/);
    assert.match(theirs!, /15 s/);
    assert.match(html, /2 learners/);
    assert.match(html, /1 finished/);

    signIn(w.teacher);
    assert.deepEqual(await outcome(() => page(pkgId)), { kind: "redirect", location: "/forbidden" });
    signIn(w.admin);
    assert.deepEqual(await outcome(() => page(randomUUID())), { kind: "notFound" });
    assert.deepEqual(await outcome(() => page("nope")), { kind: "notFound" });
  });
});

test("the package list counts learners and finishes and links to each package's tracking", { skip }, async () => {
  await withTracked(async ({ w, pkgId }) => {
    const { default: ListPage } = await import("../../apps/web/src/app/(authenticated)/admin/scorm/page.tsx");
    signIn(w.admin);
    const html = await render(withAppRouter(await ListPage({ searchParams: Promise.resolve({}) })));
    const row = rows(html).find((r) => r.includes(`Phonics ${w.T}`));
    assert.ok(row, "the package is listed");
    assert.match(row!, /2 learners · 1 finished/);
    assert.match(row!, /2\.0 MB/);
    assert.ok(openingTags(html, "a").some((a) => attr(a, "href") === `/admin/scorm/${pkgId}`));
    signIn(w.teacher);
    assert.deepEqual(await outcome(async () => ListPage({ searchParams: Promise.resolve({}) })), { kind: "redirect", location: "/forbidden" });
  });
});

test("an administrator withdraws and restores a package; learners' records stay; both are audited and documented", { skip }, async () => {
  await withTracked(async ({ w, pkgId }) => {
    const { setScormPackageActiveAction } = await import("../../apps/web/src/app/(authenticated)/admin/scorm/actions.ts");
    signIn(w.teacher);
    assert.deepEqual(await outcome(() => setScormPackageActiveAction(form({ id: pkgId, active: "false" }))), { kind: "redirect", location: "/forbidden" });

    signIn(w.admin);
    assert.deepEqual(await outcome(() => setScormPackageActiveAction(form({ id: pkgId, active: "false" }))), {
      kind: "redirect",
      location: `/admin/scorm/${pkgId}`,
    });
    const state = async () => (await w.c.query(`SELECT active FROM scorm_packages WHERE id = $1`, [pkgId])).rows[0].active;
    assert.equal(await state(), false);
    assert.equal((await w.c.query(`SELECT count(*)::int AS n FROM scorm_attempts WHERE package_id = $1`, [pkgId])).rows[0].n, 2, "records kept");
    await outcome(() => setScormPackageActiveAction(form({ id: pkgId, active: "true" })));
    assert.equal(await state(), true);
    assert.deepEqual(await outcome(() => setScormPackageActiveAction(form({ id: "nope", active: "true" }))), { kind: "notFound" });

    const { rows: audit } = await w.c.query(
      `SELECT action, entity_type, metadata FROM audit_log WHERE entity_id = $1 AND action LIKE 'scorm.package.%' ORDER BY created_at`,
      [pkgId],
    );
    assert.deepEqual(audit.map((r) => r.action), ["scorm.package.deactivate", "scorm.package.activate"]);
    const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
    const section = doc.slice(doc.indexOf("## scorm.*"));
    for (const r of audit) {
      const line = section.split("\n").find((l) => l.startsWith(`| \`${r.action}\` |`));
      assert.ok(line, `${r.action} is documented`);
      for (const key of [...Object.keys(r.metadata), r.entity_type]) assert.ok(line!.includes(`\`${key}\``), `${r.action}: ${key} documented`);
    }
  });
});

test("the subject page offers the learner her packages with her own status; a withdrawn one is not offered", { skip }, async () => {
  await withTracked(async ({ w, subjectId, pkgId }) => {
    const { default: RttSubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
    const page = async () => render(withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id: subjectId }), searchParams: Promise.resolve({}) })));

    signIn(w.teacher);
    let html = await page();
    assert.match(html, /SCORM modules \(1\)/);
    const launch = openingTags(html, "a").filter((a) => attr(a, "href") === `/scorm/${pkgId}`);
    assert.equal(launch.length, 1, "one launch link");
    const card = html.slice(html.indexOf("SCORM modules"));
    assert.match(card, /Passed/);
    assert.match(card, /72\.5/);
    assert.match(card, />Review</, "a finished module is reopened to review");

    const fresh = await w.addTeacher("Nima");
    signIn(fresh.user);
    html = await page();
    assert.match(html.slice(html.indexOf("SCORM modules")), />Start</);

    await w.c.query(`UPDATE scorm_packages SET active = false WHERE id = $1`, [pkgId]);
    signIn(w.teacher);
    html = await page();
    assert.equal(openingTags(html, "a").filter((a) => attr(a, "href") === `/scorm/${pkgId}`).length, 0, "withdrawn");
    assert.match(html, /SCORM modules \(0\)/);

    signIn(w.admin);
    html = await page();
    assert.ok(openingTags(html, "a").some((a) => attr(a, "href") === `/scorm/${pkgId}`), "an administrator still sees it");
    assert.match(html.slice(html.indexOf("SCORM modules")), /Withdrawn/);
  });
});
