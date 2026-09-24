// The quiz journey, EXECUTED: creating a quiz, editing it, opening an attempt,
// submitting it, and reading the result -- against a real Postgres, because the
// constraints that decide whether any of it works (quizzes_one_scope, the
// one-open-attempt index, the FK actions) exist only there. Until this file the
// only tests of quizzes were regexes over the source.
//
// Two ways in. Functions that take the database as an argument run inside a
// transaction that is rolled back. The pages and server actions themselves use
// the application's pool, so those tests commit rows under a unique tag and
// delete them afterwards; they are called exactly as Next calls them, with
// only the session supplied (see _stubs/auth-session.ts). A redirect() or
// notFound() is Next's thrown digest, read back by `outcome` below.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { h, renderSync, openingTags, attr } from "./_ui.js";
import { needsDatabase, withClient, tag, DATABASE_URL } from "./_harness.js";

const skip = needsDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = resolved.url.replace(/\\/g, "/");
    // The create form imports its "use server" module, which opens the
    // database pool at import time. In the app a client component only ever
    // holds a reference to the action, so the render tests get a stub instead
    // -- the same treatment _ui.ts gives the login actions -- and run without
    // a database.
    if (/\/admin\/quizzes\/actions\.ts$/.test(url) && /new-quiz-form/.test(context.parentURL ?? "")) {
      return { url: new URL("./_stubs/quiz-admin-actions.ts", import.meta.url).href, shortCircuit: true };
    }
    // _ui.ts maps @/auth to a stub with no session; these tests need one.
    if (/\/tests\/behaviour\/_stubs\/auth\.ts$/.test(url)) {
      return { url: new URL("./_stubs/auth-session.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});
const createModule = () => import("../../apps/web/src/app/(authenticated)/admin/quizzes/create-quiz.ts");
const runnerModule = () => import("../../apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx");
const resultModule = () => import("../../apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx");

// The pages hold the app's pool open; end it so the file exits promptly.
after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

/** Sign in as `userId` for every page render and action call that follows. */
function signIn(userId: string, role = "teacher"): void {
  (globalThis as Record<string, unknown>).__gmlTestSession = {
    user: { id: userId, email: `${userId}@example.test`, name: "Test user", image: null, role },
  };
}

/**
 * What a page or action did: its return value, or where it redirected, or
 * "404". Next's redirect()/notFound() throw an error whose digest carries this.
 */
async function outcome<T>(run: () => Promise<T>): Promise<{ value?: T; redirect?: string; notFound?: true }> {
  try {
    return { value: await run() };
  } catch (e) {
    const digest = (e as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return { redirect: digest.split(";")[2] };
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { notFound: true };
    throw e;
  }
}

type QuizWorld = {
  c: Client;
  t: string;
  slug: string;
  quizId: string;
  userId: string;
  /** Question ids in sequence order; the correct option of each is `KEY-<n>-<tag>`. */
  questionIds: string[];
  q: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;
};

/**
 * A committed quiz with three questions, bound to its own RTT subject, and a
 * teacher to take it. Everything is deleted afterwards (audit_log is
 * append-only by design, so the rows the actions write there stay).
 */
async function withQuiz(
  opts: { maxAttempts?: number | null; timeLimitSeconds?: number | null; passThreshold?: number },
  body: (w: QuizWorld) => Promise<void>,
): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const t = tag("quiz");
  const q = async <R,>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as R[];
  const one = async (sql: string, params: unknown[]) => ((await q<{ id: string }>(sql, params))[0]!).id;
  const subjectId = await rttSubject(c, t);
  const userId = await one(
    `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, 'Learner', 'teacher') RETURNING id`,
    [`${t}@example.test`],
  );
  const quizId = await one(
    `INSERT INTO quizzes (slug, title, rtt_subject_id, pass_threshold, max_attempts, time_limit_seconds, active)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [t, `Quiz ${t}`, subjectId, opts.passThreshold ?? 60, opts.maxAttempts ?? null, opts.timeLimitSeconds ?? null],
  );
  const questionIds: string[] = [];
  for (let n = 1; n <= 3; n++) {
    questionIds.push(
      await one(
        `INSERT INTO quiz_questions (quiz_id, sequence, prompt, options, correct_index, explanation)
           VALUES ($1, $2, $3, $4::jsonb, 0, $5) RETURNING id`,
        [quizId, n, `Question ${n} ${t}`, JSON.stringify([`KEY-${n}-${t}`, `wrong-${n}-a`, `wrong-${n}-b`]), `EXPLAIN-${n}-${t}`],
      ),
    );
  }
  try {
    await body({ c, t, slug: t, quizId, userId, questionIds, q });
  } finally {
    await c.query(`DELETE FROM quizzes WHERE id = $1`, [quizId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.query(
      `DELETE FROM phases WHERE id = (SELECT t.phase_id FROM rtt_subjects s JOIN terms t ON t.id = s.term_id WHERE s.id = $1)`,
      [subjectId],
    );
    await c.end();
  }
}

/** Every question answered with option `pick` (0 is the key). */
const answerAll = (w: QuizWorld, pick: number) => w.questionIds.map((questionId) => ({ questionId, selectedIndex: pick }));

/** A phase, a term and an RTT subject: the smallest scope a quiz can have. */
async function rttSubject(c: Client, t: string): Promise<string> {
  const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
  const phase = await one(`INSERT INTO phases (label, sequence) VALUES ($1, 99) RETURNING id`, [t.slice(-24)]);
  const term = await one(`INSERT INTO terms (phase_id, name, sequence) VALUES ($1, $2, 1) RETURNING id`, [phase, `Term ${t}`]);
  return one(`INSERT INTO rtt_subjects (term_id, name) VALUES ($1, $2) RETURNING id`, [term, `Subject ${t}`]);
}

/** Run `body` in a transaction that is always rolled back. */
async function rolledBack(body: (c: Client) => Promise<void>): Promise<void> {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await body(c);
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

// ── F32: creating a quiz ─────────────────────────────────────────────────────

test("F32: the create form's values produce a quiz bound to the chosen RTT subject", { skip }, async () => {
  const { createQuiz } = await createModule();
  await rolledBack(async (c) => {
    const t = tag("qcreate");
    const subjectId = await rttSubject(c, t);
    const res = await createQuiz(drizzle(c), { title: "Mid-unit check", slug: t, passThreshold: "60", rttSubjectId: subjectId });
    assert.equal(res.ok, true, `createQuiz refused the form: ${JSON.stringify(res)}`);
    const row = (await c.query(`SELECT rtt_subject_id, subject_id, active FROM quizzes WHERE slug = $1`, [t])).rows[0];
    assert.deepEqual(row, { rtt_subject_id: subjectId, subject_id: null, active: false });
  });
});

test("F32: a missing or unknown RTT subject is refused with a message, before the INSERT", { skip }, async () => {
  const { createQuiz } = await createModule();
  await rolledBack(async (c) => {
    const t = tag("qcreate");
    for (const rttSubjectId of ["", "not-a-uuid", randomUUID()]) {
      const res = await createQuiz(drizzle(c), { title: "Endline", slug: t, passThreshold: "60", rttSubjectId });
      assert.equal(res.ok, false, `accepted rttSubjectId=${JSON.stringify(rttSubjectId)}`);
      assert.match((res as { error: string }).error, /RTT subject/);
    }
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM quizzes WHERE slug = $1`, [t])).rows[0].n, 0);
  });
});

test("F32: deleting an RTT subject that has a quiz is refused as still-referenced (23503), not a CHECK violation", { skip }, async () => {
  await rolledBack(async (c) => {
    const t = tag("qcreate");
    const subjectId = await rttSubject(c, t);
    await c.query(`INSERT INTO quizzes (slug, title, rtt_subject_id) VALUES ($1, 'Mid-unit', $2)`, [t, subjectId]);
    await c.query("SAVEPOINT del");
    const err = await c.query(`DELETE FROM rtt_subjects WHERE id = $1`, [subjectId]).then(
      () => null,
      (e: { code?: string }) => e,
    );
    await c.query("ROLLBACK TO SAVEPOINT del");
    // 23503 is what the admin grid's describeDbError reports as "still in use";
    // ON DELETE SET NULL produced 23514 (the row it wrote broke quizzes_one_scope),
    // which the grid can only call "delete_failed".
    assert.equal(err?.code, "23503", `expected a foreign-key refusal, got ${JSON.stringify(err)}`);
  });
});

test("F32: the create form asks for the RTT subject the quiz belongs to", async () => {
  const { NewQuizForm } = await import("../../apps/web/src/app/(authenticated)/admin/quizzes/new-quiz-form.tsx");
  const subjects = [{ id: randomUUID(), label: "Phase 1 · Term 1 · English" }];
  const html = renderSync(h(NewQuizForm as never, { startOpen: true, subjects } as never));
  const select = openingTags(html, "select").find((s) => attr(s, "name") === "rttSubjectId");
  assert.ok(select, "the form has no rttSubjectId select, so no quiz it submits can satisfy quizzes_one_scope");
  assert.ok(/\srequired(=|\s|>)/.test(select!), "the subject must be required");
  assert.match(html, /English/);
});

test("F32: with no RTT subjects the create form says what to do instead of failing on submit", async () => {
  const { NewQuizForm } = await import("../../apps/web/src/app/(authenticated)/admin/quizzes/new-quiz-form.tsx");
  const html = renderSync(h(NewQuizForm as never, { startOpen: true, subjects: [] } as never));
  const submit = openingTags(html, "button").find((b) => attr(b, "type") === "submit");
  assert.ok(submit && /\sdisabled(=|\s|>)/.test(submit), "submit must be disabled when there is nothing to bind the quiz to");
  assert.match(html, /RTT subject/);
});

// ── Driving the runner as a browser does ─────────────────────────────────────

type AnyEl = { type: unknown; props: Record<string, unknown> };
type RunnerProps = {
  slug: string;
  timeLimitSeconds?: number | null;
  submitAction: (slug: string, answers: Array<{ questionId: string; selectedIndex: number | null }>) => Promise<void>;
};

function findElement(node: unknown, match: (el: AnyEl) => boolean): AnyEl | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElement(n, match);
      if (hit) return hit;
    }
  } else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as AnyEl;
    if (match(el)) return el;
    return findElement(el.props.children, match);
  }
  return undefined;
}

/** GET /quizzes/<slug> as the signed-in learner: the page, its HTML, and the runner's props. */
async function openRunner(w: QuizWorld, searchParams: Record<string, string> = {}) {
  const { default: Page } = await runnerModule();
  const res = await outcome(() =>
    Page({ params: Promise.resolve({ slug: w.slug }), searchParams: Promise.resolve(searchParams) }),
  );
  if (!res.value) return { redirect: res.redirect, notFound: res.notFound };
  const runner = findElement(res.value, (el) => typeof el.props.submitAction === "function");
  return { html: renderSync(res.value), runner: runner?.props as RunnerProps | undefined };
}

/** What the runner's Submit button does: call the action the page handed it. */
function submit(runner: RunnerProps | undefined, answers: Array<{ questionId: string; selectedIndex: number | null }>) {
  assert.ok(runner, "the runner page rendered no runner");
  return outcome(() => runner!.submitAction(runner!.slug, answers));
}

/** Take the quiz start to finish; returns the result page's submission id. */
async function takeQuiz(w: QuizWorld, answers: Array<{ questionId: string; selectedIndex: number | null }>): Promise<string> {
  const { runner } = await openRunner(w);
  const res = await submit(runner, answers);
  const m = res.redirect?.match(/\/result\/([0-9a-f-]{36})$/);
  assert.ok(m, `the submission was not accepted: ${JSON.stringify(res)}`);
  return m![1]!;
}

async function resultHtml(w: QuizWorld, submissionId: string): Promise<string> {
  const { default: Result } = await resultModule();
  return renderSync(await Result({ params: Promise.resolve({ slug: w.slug, submissionId }) }));
}

// ── F34: the answer key on the result page ───────────────────────────────────

test("F34: a failed attempt with attempts left does not reveal the answer key or the explanations", { skip }, async () => {
  await withQuiz({ maxAttempts: 3 }, async (w) => {
    signIn(w.userId);
    const html = await resultHtml(w, await takeQuiz(w, answerAll(w, 1)));
    assert.match(html, /wrong-1-a/, "the learner's own answer is shown");
    assert.doesNotMatch(html, /KEY-\d-/, "the correct option is printed next to a Retake button");
    assert.doesNotMatch(html, /EXPLAIN-\d-/, "the explanation gives the answer away too");
    assert.match(html, /Retake/, "attempts remain, so retaking is offered");
  });
});

test("F34: on an uncapped quiz the key stays hidden until the learner passes", { skip }, async () => {
  await withQuiz({ maxAttempts: null }, async (w) => {
    signIn(w.userId);
    const failed = await takeQuiz(w, answerAll(w, 2));
    assert.doesNotMatch(await resultHtml(w, failed), /KEY-\d-/);
    const passed = await takeQuiz(w, answerAll(w, 0));
    assert.match(await resultHtml(w, passed), /EXPLAIN-1-/, "once passed, the explanations are the point of the page");
    assert.match(await resultHtml(w, failed), /KEY-1-/, "and the earlier attempt can be reviewed in full");
  });
});

test("F34: the key is shown once the last attempt is used, and Retake is no longer offered", { skip }, async () => {
  await withQuiz({ maxAttempts: 1 }, async (w) => {
    signIn(w.userId);
    const html = await resultHtml(w, await takeQuiz(w, answerAll(w, 1)));
    assert.match(html, /KEY-1-/);
    assert.match(html, /EXPLAIN-1-/);
    assert.doesNotMatch(html, />Retake</, "a Retake link would only bounce to the history page");
  });
});
