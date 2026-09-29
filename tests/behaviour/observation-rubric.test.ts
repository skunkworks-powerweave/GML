// The scored rubric on an observation cycle.
//
// ── WHAT IS PROMISED ─────────────────────────────────────────────────────────
//
// The design (docs/superpowers/specs/2026-09-28-teaching-records-design.md):
// "The observer scores the rubric on the observer form", and "the cycle shows
// the total and level". Until now the observer form was one narrative box and
// observation_scores (migration 0043) was read and written by nothing.
//
//   - the observer scores each criterion 0..max with an optional note, in the
//     same transaction as the observer form; the cycle records its rubric
//   - a missing or out-of-range score is refused and nothing is recorded
//   - the observer revises the scores until the cycle is signed off; a
//     signed-off cycle refuses them
//   - everyone who can open the cycle -- the teacher too, for her own cycle --
//     reads the scores, total / maximum, percentage and band; nobody else can
//   - no rubric configured: the observer form is the narrative alone
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real server actions and cycle page (./_server-actions.ts) against a
// committed observation programme (./_observation-world.ts), with a rubric and
// grading scale of this file's own (never the default ones, which other suites
// may be creating at the same moment). The rubric resolution's default path
// runs on a transaction that is rolled back.

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, request, resetRequest, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { observationWorld, type ObservationWorld } from "./_observation-world.js";
import { phoneLayoutIssues, parseMarkup, walk, PHONE_WIDTH } from "./_phone-layout.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
after(closeAppDb);
afterEach(resetRequest);

const actions = () => import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");
const rubricLib = () => import("../../apps/web/src/lib/observation/rubric.ts");

type Tree = { [k: string]: string | Tree };
function msg(locale: "en" | "hi" | "bo", path: string): string {
  const v = path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], loadMessages(locale));
  assert.equal(typeof v, "string", `${locale}:${path} is a message`);
  return v as string;
}

/** Visible text, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

async function renderCycle(user: TestUser, cycleId: string, sp: Record<string, string> = {}): Promise<string> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  return render(withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve(sp) })));
}

/**
 * A rubric of three criteria, each scored 0..4, graded on a scale of its own:
 * A 80-100, B 60-79, C 0-59 (C does not pass).
 */
async function scoredRubric(w: ObservationWorld) {
  const { c, T } = w;
  const scaleId = (
    await c.query(`INSERT INTO grading_scales (name, applies_to) VALUES ($1, 'observation') RETURNING id`, [`Scale ${T}`])
  ).rows[0].id as string;
  await c.query(
    `INSERT INTO grading_bands (scale_id, label, min_pct, max_pct, is_pass, sequence)
     VALUES ($1, 'A', 80, 100, true, 1), ($1, 'B', 60, 79, true, 2), ($1, 'C', 0, 59, false, 3)`,
    [scaleId],
  );
  const rubricId = (
    await c.query(`INSERT INTO observation_rubrics (name, grading_scale_id) VALUES ($1, $2) RETURNING id`, [`Rubric ${T}`, scaleId])
  ).rows[0].id as string;
  const titles = [`Questioning ${T}`, `Pacing ${T}`, `Checks ${T}`];
  const criteria: string[] = [];
  for (const [i, title] of titles.entries()) {
    criteria.push(
      (
        await c.query(
          `INSERT INTO rubric_criteria (rubric_id, sequence, title, description, max_score) VALUES ($1, $2, $3, $4, 4) RETURNING id`,
          [rubricId, i + 1, title, `What ${title} looks like`],
        )
      ).rows[0].id as string,
    );
  }
  /** A cycle for the world's teacher that scores with this rubric. */
  const cycle = async (status: string) => {
    const cyc = await w.cycle({ status });
    await c.query(`UPDATE observation_cycles SET rubric_id = $1 WHERE id = $2`, [rubricId, cyc.id]);
    return cyc;
  };
  const scores = (values: number[], notes: Record<number, string> = {}) =>
    Object.fromEntries(
      criteria.flatMap((id, i) => [
        [`score_${id}`, String(values[i])],
        ...(notes[i] ? [[`scoreNote_${id}`, notes[i]!]] : []),
      ]),
    ) as Record<string, string>;
  const cleanup = async () => {
    await c.query(`DELETE FROM approvals WHERE item_id IN (SELECT id FROM observation_cycles WHERE teacher_id = $1)`, [w.teacherId]);
    await c.query(`DELETE FROM observation_scores WHERE criterion_id = ANY($1::uuid[])`, [criteria]);
    await c.query(`DELETE FROM observation_rubrics WHERE id = $1`, [rubricId]);
    await c.query(`DELETE FROM grading_scales WHERE id = $1`, [scaleId]);
  };
  return { scaleId, rubricId, criteria, titles, cycle, scores, cleanup };
}

async function savedScores(w: ObservationWorld, cycleId: string) {
  return (
    await w.c.query(
      `SELECT s.criterion_id, s.score, s.note, s.scored_by_user_id FROM observation_scores s
         JOIN rubric_criteria rc ON rc.id = s.criterion_id
        WHERE s.cycle_id = $1 ORDER BY rc.sequence`,
      [cycleId],
    )
  ).rows as { criterion_id: string; score: number; note: string | null; scored_by_user_id: string }[];
}

/** The audit rows for `action` on this cycle, once the voided inserts have landed. */
async function auditRows(w: ObservationWorld, cycleId: string, action: string, atLeast = 1) {
  let rows: { user_id: string; metadata: Record<string, unknown> }[] = [];
  for (let i = 0; i < 40; i++) {
    rows = (
      await w.c.query(`SELECT user_id, metadata FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY created_at`, [cycleId, action])
    ).rows;
    if (rows.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

// ── Pure: the server's reading of the posted scores ─────────────────────────

test("a score is a whole number from 0 to the criterion's maximum, for every criterion", async () => {
  const { parseRubricScores } = await rubricLib();
  const rubric = {
    id: "r",
    name: "R",
    description: null,
    gradingScaleId: null,
    criteria: [
      { id: "a", sequence: 1, title: "A", description: null, maxScore: 4 },
      { id: "b", sequence: 2, title: "B", description: null, maxScore: 2 },
    ],
  };
  const post = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return parseRubricScores(rubric, fd);
  };
  assert.deepEqual(post({ score_a: "4", score_b: " 0 ", scoreNote_a: "  kept\r\nas typed  " }), {
    ok: true,
    scores: [
      { criterionId: "a", score: 4, note: "kept\nas typed" },
      { criterionId: "b", score: 0, note: null },
    ],
  });
  for (const bad of ["", "5", "-1", "2.5", "two", "1e0"]) {
    assert.deepEqual(post({ score_a: bad, score_b: "1" }), { ok: false, criterionId: "a" }, `score ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(post({ score_a: "1", score_b: "3" }), { ok: false, criterionId: "b" }, "over this criterion's own maximum");
  assert.deepEqual(post({ score_a: "1" }), { ok: false, criterionId: "b" }, "every criterion needs a score");
  assert.deepEqual(post({ score_a: "1", score_b: "1", scoreNote_b: "x".repeat(5001) }), { ok: false, criterionId: "b" });
  // Keys of any other rubric are not read.
  assert.deepEqual(post({ score_a: "1", score_b: "1", score_zzz: "9" }).ok, true);
});

// ── Committed programme ─────────────────────────────────────────────────────

test("the observer scores the rubric with the observer form; the scores are saved, graded and shown to the teacher", { skip }, async () => {
  const w = await observationWorld("rubricsave");
  const r = await scoredRubric(w);
  try {
    const { submitObserverFormAction } = await actions();
    const cyc = await r.cycle("pre_submitted");
    await w.grant(w.observer.id);

    // The observer form shows every criterion, with its title and a score to pick.
    const formPage = await renderCycle(w.observer, cyc.id);
    for (const [i, id] of r.criteria.entries()) {
      assert.match(formPage, new RegExp(`name="score_${id}"[^>]*value="4"|value="4"[^>]*name="score_${id}"`), `criterion ${i + 1} can be scored 4`);
      assert.ok(text(formPage).includes(r.titles[i]!), `criterion ${i + 1}'s title is shown`);
    }
    assert.match(formPage, /name="narrativeComments"/, "the narrative is still asked for");

    signIn(w.observer);
    const done = await outcome(() =>
      submitObserverFormAction(
        form({ cycleId: cyc.id, narrativeComments: "Clear lesson", ...r.scores([4, 3, 2], { 0: "Open questions throughout" }) }),
      ),
    );
    assert.deepEqual(done, { kind: "redirect", location: `/observation/${cyc.id}` });

    const row = (await w.c.query(`SELECT status, rubric_id FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0];
    assert.equal(row.status, "observed");
    assert.equal(row.rubric_id, r.rubricId, "the cycle records the rubric it was scored with");
    assert.deepEqual(
      (await savedScores(w, cyc.id)).map((s) => [s.score, s.note, s.scored_by_user_id]),
      [
        [4, "Open questions throughout", w.observer.id],
        [3, null, w.observer.id],
        [2, null, w.observer.id],
      ],
    );
    const form_ = (await w.c.query(`SELECT responses FROM observation_forms WHERE cycle_id = $1 AND kind = 'observer'`, [cyc.id])).rows[0];
    assert.deepEqual(form_.responses, { narrativeComments: "Clear lesson" }, "the scores are not stuffed into the form's answers");

    const [audit] = await auditRows(w, cyc.id, "observation.scores.saved");
    assert.ok(audit, "the scores are audited");
    assert.equal(audit!.user_id, w.observer.id);
    assert.deepEqual(audit!.metadata, { code: cyc.code, rubricId: r.rubricId, criteria: 3, total: 9, max: 12 });

    // The teacher reads them on her own cycle: per criterion, the total, the
    // percentage and the band (9 of 12 is 75%: B).
    await w.grant(w.teacher.id);
    const page = await renderCycle(w.teacher, cyc.id);
    const shown = text(page);
    assert.match(page, /data-testid="rubric-total"[^>]*>9 \/ 12</);
    assert.match(page, /data-testid="rubric-pct"[^>]*>75%</);
    assert.match(page, /data-testid="rubric-band"[^>]*>Level B</);
    assert.ok(shown.includes(r.titles[0]!) && shown.includes("Open questions throughout"), "each criterion, with the note");
    assert.match(shown, /4 \/ 4 .*3 \/ 4 .*2 \/ 4/, "each criterion's score, in rubric order");
    assert.doesNotMatch(page, /name="score_/, "the teacher is offered no score to change");

    // Every other party on the cycle reads them too.
    for (const u of [w.mentor, w.admin]) {
      await w.grant(u.id);
      assert.match(await renderCycle(u, cyc.id), /data-testid="rubric-band"[^>]*>Level B</, u.role);
    }
  } finally {
    await r.cleanup();
    await w.cleanup();
  }
});

test("a missing or out-of-range score is refused, the criterion is named, and nothing is recorded", { skip }, async () => {
  const w = await observationWorld("rubricbad");
  const r = await scoredRubric(w);
  try {
    const { submitObserverFormAction } = await actions();
    const cyc = await r.cycle("pre_submitted");
    await w.grant(w.observer.id);
    signIn(w.observer);
    const missing = { ...r.scores([4, 3, 2]) };
    delete missing[`score_${r.criteria[2]}`];
    for (const fields of [missing, r.scores([4, 5, 2]), r.scores([4, 3, -1])]) {
      const res = await outcome(() => submitObserverFormAction(form({ cycleId: cyc.id, narrativeComments: "Clear lesson", ...fields })));
      assert.equal(res.kind, "redirect");
      assert.match((res as { location: string }).location, new RegExp(`^/observation/${cyc.id}\\?error=invalid_score&criterion=`));
    }
    const row = (await w.c.query(`SELECT status, rubric_id FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0];
    assert.equal(row.status, "pre_submitted", "the cycle did not move");
    assert.equal((await savedScores(w, cyc.id)).length, 0, "no score was written");
    assert.equal(
      (await w.c.query(`SELECT count(*)::int AS n FROM observation_forms WHERE cycle_id = $1 AND kind = 'observer'`, [cyc.id])).rows[0].n,
      0,
      "nor the observer form",
    );

    // The page names the criterion from the rubric, never the raw parameter.
    const named = text(await renderCycle(w.observer, cyc.id, { error: "invalid_score", criterion: r.criteria[1]! }));
    assert.ok(named.includes(`The score for "${r.titles[1]}" was missing or out of range`), named.slice(0, 400));
    const forged = text(await renderCycle(w.observer, cyc.id, { error: "invalid_score", criterion: "<b>not a criterion</b>" }));
    assert.ok(forged.includes("A score was missing or out of range"));
    assert.ok(!forged.includes("not a criterion"));
  } finally {
    await r.cleanup();
    await w.cleanup();
  }
});

test("the observer revises the scores until sign-off; nobody else may, and a signed-off cycle refuses them", { skip }, async () => {
  const w = await observationWorld("rubricrev");
  const r = await scoredRubric(w);
  try {
    const { submitObserverFormAction, saveScoresAction } = await actions();
    const cyc = await r.cycle("pre_submitted");
    await w.grant(w.observer.id);
    signIn(w.observer);
    await outcome(() => submitObserverFormAction(form({ cycleId: cyc.id, narrativeComments: "Clear lesson", ...r.scores([1, 1, 1]) })));

    // Offered, with what was saved selected.
    const offered = await renderCycle(w.observer, cyc.id);
    assert.match(offered, /data-testid="rubric-card"/);
    const radio = (html: string, criterion: string, value: string) =>
      (html.match(/<input[^>]*>/g) ?? []).find((tag) => tag.includes(`name="score_${criterion}"`) && tag.includes(`value="${value}"`));
    assert.match(radio(offered, r.criteria[0]!, "1") ?? "", /checked=""/, "the saved score is selected");
    assert.doesNotMatch(radio(offered, r.criteria[0]!, "2") ?? "", /checked=""/);

    signIn(w.observer);
    const revised = await outcome(() => saveScoresAction(form({ cycleId: cyc.id, ...r.scores([4, 4, 3], { 2: "Better on a second look" }) })));
    assert.deepEqual(revised, { kind: "redirect", location: `/observation/${cyc.id}` });
    assert.deepEqual((await savedScores(w, cyc.id)).map((s) => [s.score, s.note]), [[4, null], [4, null], [3, "Better on a second look"]]);
    assert.equal((await auditRows(w, cyc.id, "observation.scores.saved", 2)).length, 2, "the revision is audited too");
    // 11 of 12 is 92%: A.
    assert.match(await renderCycle(w.observer, cyc.id), /data-testid="rubric-band"[^>]*>Level A</);

    // Still open while the sign-off waits.
    await w.c.query(`UPDATE observation_cycles SET status = 'post_submitted' WHERE id = $1`, [cyc.id]);
    signIn(w.observer);
    assert.equal((await outcome(() => saveScoresAction(form({ cycleId: cyc.id, ...r.scores([4, 4, 4]) })))).kind, "redirect");
    assert.deepEqual((await savedScores(w, cyc.id)).map((s) => s.score), [4, 4, 4]);

    // The teacher may not score her own lesson; an observer not on the cycle
    // is told it does not exist.
    await w.grant(w.teacher.id);
    signIn(w.teacher);
    assert.deepEqual(await outcome(() => saveScoresAction(form({ cycleId: cyc.id, ...r.scores([0, 0, 0]) }))), {
      kind: "redirect",
      location: "/forbidden",
    });
    await w.grant(w.otherObserver.id);
    signIn(w.otherObserver);
    assert.deepEqual(await outcome(() => saveScoresAction(form({ cycleId: cyc.id, ...r.scores([0, 0, 0]) }))), { kind: "notFound" });
    // Without the section password nothing happens either.
    const lockedOut = await w.cycle({ status: "observed" });
    signIn(w.mentor); // the mentor holds no grant in this test
    const gated = await outcome(() => saveScoresAction(form({ cycleId: lockedOut.id, ...r.scores([0, 0, 0]) })));
    assert.equal(gated.kind, "redirect");
    assert.match((gated as { location: string }).location, /^\/gate\/observation/);

    // Signed off: closed.
    await w.c.query(`UPDATE observation_cycles SET status = 'complete' WHERE id = $1`, [cyc.id]);
    signIn(w.observer);
    assert.deepEqual(await outcome(() => saveScoresAction(form({ cycleId: cyc.id, ...r.scores([0, 0, 0]) }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}?error=cycle_locked`,
    });
    assert.deepEqual((await savedScores(w, cyc.id)).map((s) => s.score), [4, 4, 4], "a signed-off record does not change");
    const closed = await renderCycle(w.observer, cyc.id);
    assert.match(closed, /data-testid="rubric-scores"/, "the scores stay readable");
    assert.doesNotMatch(closed, /name="score_/, "but are no longer offered for change");
  } finally {
    await r.cleanup();
    await w.cleanup();
  }
});

test("another teacher cannot read a cycle's scores", { skip }, async () => {
  const w = await observationWorld("rubricpriv");
  const r = await scoredRubric(w);
  const otherUser = (
    await w.c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [
      `other.${w.T}@example.test`,
      `Other ${w.T}`,
    ])
  ).rows[0].id as string;
  const otherTeacher = (
    await w.c.query(`INSERT INTO teachers (user_id, school_id, full_name) VALUES ($1, $2, $3) RETURNING id`, [otherUser, w.schoolId, `Other Row ${w.T}`])
  ).rows[0].id as string;
  try {
    const cyc = await r.cycle("observed");
    await w.c.query(`INSERT INTO observation_scores (cycle_id, criterion_id, score) SELECT $1, unnest($2::uuid[]), 3`, [cyc.id, r.criteria]);
    await w.grant(otherUser);
    signIn({ id: otherUser, role: "teacher" });
    const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
    assert.deepEqual(
      await outcome(() => CycleDetailPage({ params: Promise.resolve({ cycleId: cyc.id }), searchParams: Promise.resolve({}) })),
      { kind: "notFound" },
    );
  } finally {
    await w.c.query(`DELETE FROM section_gate_grants WHERE user_id = $1`, [otherUser]);
    await w.c.query(`DELETE FROM teachers WHERE id = $1`, [otherTeacher]);
    await w.c.query(`DELETE FROM users WHERE id = $1`, [otherUser]);
    await r.cleanup();
    await w.cleanup();
  }
});

test("the cycle's own rubric, else the active default; none configured, nothing to score", { skip }, async () => {
  const { rubricFor } = await rubricLib();
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const db = drizzle(c) as never;
      // No default anywhere (inside this transaction only).
      await c.query(`UPDATE observation_rubrics SET is_default = false WHERE is_default`);
      assert.equal(await rubricFor(db, null), null, "no rubric configured: the observer form is the narrative alone");

      const mk = async (name: string, isDefault: boolean, active: boolean, criteria: number) => {
        const id = (
          await c.query(`INSERT INTO observation_rubrics (name, is_default, active) VALUES ($1, $2, $3) RETURNING id`, [name, isDefault, active])
        ).rows[0].id as string;
        for (let i = 1; i <= criteria; i++) {
          await c.query(`INSERT INTO rubric_criteria (rubric_id, sequence, title, max_score) VALUES ($1, $2, $3, 3)`, [id, i, `${name} ${i}`]);
        }
        return id;
      };
      const empty = await mk(`Empty ${Date.now()}`, true, true, 0);
      assert.equal(await rubricFor(db, null), null, "a default with no criteria scores nothing");
      await c.query(`UPDATE observation_rubrics SET is_default = false WHERE id = $1`, [empty]);

      const inactive = await mk(`Inactive ${Date.now()}`, true, false, 2);
      assert.equal(await rubricFor(db, null), null, "an inactive default is not used for new scoring");
      await c.query(`UPDATE observation_rubrics SET is_default = false WHERE id = $1`, [inactive]);

      const def = await mk(`Default ${Date.now()}`, true, true, 2);
      const own = await mk(`Own ${Date.now()}`, false, false, 3);
      const d = await rubricFor(db, null);
      assert.equal(d?.id, def);
      assert.deepEqual(d?.criteria.map((x) => x.sequence), [1, 2]);
      assert.equal((await rubricFor(db, own))?.criteria.length, 3, "a cycle keeps the rubric it was scored with, even once retired");
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

test("the rubric and the sign-off controls fit a phone, and every control is named", { skip }, async () => {
  const w = await observationWorld("rubricphone");
  const r = await scoredRubric(w);
  try {
    const cyc = await r.cycle("post_submitted");
    await w.c.query(`INSERT INTO observation_scores (cycle_id, criterion_id, score) SELECT $1, unnest($2::uuid[]), 3`, [cyc.id, r.criteria]);
    await w.grant(w.mentor.id);
    const scoring = await r.cycle("pre_submitted");
    await w.grant(w.observer.id);
    for (const [user, cycleId, expect] of [
      [w.mentor, cyc.id, /data-testid="signoff-panel"[\s\S]*data-testid="rubric-card"/],
      [w.observer, scoring.id, /data-testid="rubric-fields"/],
    ] as const) {
      request.cookies = { "gml-device": "mobile" };
      const html = await renderCycle(user, cycleId);
      request.cookies = {};
      assert.match(html, expect, user.role);
      assert.deepEqual(await phoneLayoutIssues(html), [], `${user.role}'s cycle page at ${PHONE_WIDTH}px`);
      // Named: a radio by its aria-label, a box by its <label for>.
      const root = parseMarkup(html);
      const labelled = new Set<string>();
      for (const el of walk(root)) if (el.tag === "label" && el.attrs.for) labelled.add(el.attrs.for);
      const unnamed = [...walk(root)].filter(
        (el) =>
          (el.tag === "textarea" || (el.tag === "input" && el.attrs.type === "radio")) &&
          !(el.attrs["aria-label"] ?? "").trim() &&
          !(el.attrs.id && labelled.has(el.attrs.id)),
      );
      assert.deepEqual(unnamed.map((el) => el.attrs.name), [], `${user.role}: unnamed controls`);
    }
  } finally {
    await r.cleanup();
    await w.cleanup();
  }
});

test("the scores are shown in the reader's language", { skip }, async () => {
  const w = await observationWorld("rubricbo");
  const r = await scoredRubric(w);
  try {
    const cyc = await r.cycle("observed");
    await w.c.query(
      `INSERT INTO observation_scores (cycle_id, criterion_id, score, scored_by_user_id) SELECT $1, unnest($2::uuid[]), 2, $3`,
      [cyc.id, r.criteria, w.observer.id],
    );
    await w.grant(w.teacher.id);
    request.locale = "bo";
    const out = text(await renderCycle(w.teacher, cyc.id));
    for (const path of ["observation.cycle.rubric.title"]) {
      assert.ok(out.includes(msg("bo", path)), `bo: ${path}`);
    }
    // 6 of 12 is 50%: C, the band's own label (data).
    assert.ok(out.includes(msg("bo", "observation.cycle.rubric.band").replace("{band}", "C")), out.slice(0, 600));
    for (const english of ["Rubric scores", "Level C", "Last scored by", "Not scored"]) {
      assert.ok(!out.includes(english), `bo: "${english}" is still English`);
    }
  } finally {
    await r.cleanup();
    await w.cleanup();
  }
});
