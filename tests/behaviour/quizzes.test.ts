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
import { h, renderSync, openingTags, attr, React, hostElements, textOf, withAppRouter } from "./_ui.js";
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
const historyModule = () => import("../../apps/web/src/app/(authenticated)/quizzes/[slug]/history/page.tsx");
const editorActions = () => import("../../apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts");
const editorPage = () => import("../../apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx");

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

// ── F92: the countdown and the server's grace ────────────────────────────────

/** Move the learner's open attempt's start `seconds` into the past. */
async function backdateOpenAttempt(w: QuizWorld, seconds: number): Promise<void> {
  await w.q(
    `UPDATE quiz_attempts SET started_at = now() - make_interval(secs => $2)
      WHERE quiz_id = $1 AND user_id = $3 AND closed_at IS NULL`,
    [w.quizId, seconds, w.userId],
  );
}

test("F92: a fresh timed attempt counts down the time limit, not the limit plus the server's grace", { skip }, async () => {
  await withQuiz({ timeLimitSeconds: 60 }, async (w) => {
    signIn(w.userId);
    const { runner } = await openRunner(w);
    const shown = runner?.timeLimitSeconds;
    assert.ok(typeof shown === "number" && shown <= 60 && shown >= 58, `countdown starts at ${shown}s on a 60s quiz`);
  });
});

test("F92: an auto-submit at 00:00 that takes a few seconds to arrive is scored, not discarded", { skip }, async () => {
  await withQuiz({ timeLimitSeconds: 60 }, async (w) => {
    signIn(w.userId);
    await openRunner(w);
    // The learner reloads 20 s in; the page hands the runner what is left.
    await backdateOpenAttempt(w, 20);
    const { runner } = await openRunner(w);
    const left = runner!.timeLimitSeconds!;
    // The runner counts `left` down to 00:00 and auto-submits; on a Ladakh
    // link the page load and the POST add seconds the server sees and the
    // countdown did not.
    const latency = 5;
    await backdateOpenAttempt(w, 20 + left + latency);
    const res = await submit(runner, answerAll(w, 0));
    assert.match(res.redirect ?? "", /\/result\//, `an on-time auto-submit was refused: ${JSON.stringify(res)}`);
    const [row] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM quiz_submissions WHERE quiz_id = $1`, [w.quizId]);
    assert.equal(row!.n, 1);
  });
});

test("F92: the limit is still enforced -- a submit arriving after limit + grace is not scored", { skip }, async () => {
  await withQuiz({ timeLimitSeconds: 60 }, async (w) => {
    signIn(w.userId);
    const { runner } = await openRunner(w);
    await backdateOpenAttempt(w, 60 + 31);
    const res = await submit(runner, answerAll(w, 0));
    assert.match(res.redirect ?? "", /error=time_expired/);
    const [row] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM quiz_submissions WHERE quiz_id = $1`, [w.quizId]);
    assert.equal(row!.n, 0);
  });
});

// ── F37: the attempt is what a submission belongs to ─────────────────────────

const submissionCount = async (w: QuizWorld) =>
  (await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM quiz_submissions WHERE quiz_id = $1`, [w.quizId]))[0]!.n;
const openAttempts = async (w: QuizWorld) =>
  (await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM quiz_attempts WHERE quiz_id = $1 AND closed_at IS NULL`, [w.quizId]))[0]!.n;

test("F37: submitting the same attempt twice records one submission", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(w.userId);
    const { runner } = await openRunner(w);
    assert.match((await submit(runner, answerAll(w, 0))).redirect ?? "", /\/result\//);
    const again = await submit(runner, answerAll(w, 1));
    assert.doesNotMatch(again.redirect ?? "", /\/result\//, "a closed attempt produced a second result");
    assert.match(again.redirect ?? "", /\/history\?error=attempt_closed$/);
    assert.equal(await submissionCount(w), 1);
  });
});

test("F37: a timed quiz cannot be submitted around its clock from a second tab", { skip }, async () => {
  await withQuiz({ timeLimitSeconds: 60 }, async (w) => {
    signIn(w.userId);
    // Two tabs render the runner; both share the one open attempt.
    const tabA = (await openRunner(w)).runner;
    const tabB = (await openRunner(w)).runner;
    assert.match((await submit(tabB, answerAll(w, 1))).redirect ?? "", /\/result\//);
    // Tab A keeps going long past the limit. There is no open attempt left
    // for it -- which used to mean no time check at all.
    const late = await submit(tabA, answerAll(w, 0));
    assert.doesNotMatch(late.redirect ?? "", /\/result\//, "an unbounded second sitting was scored");
    assert.equal(await submissionCount(w), 1);
  });
});

test("F37: concurrent submits of one attempt record one submission, under the cap", { skip }, async () => {
  await withQuiz({ maxAttempts: 1 }, async (w) => {
    signIn(w.userId);
    const { runner } = await openRunner(w);
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(runner, answerAll(w, 1))));
    const accepted = results.filter((r) => /\/result\//.test(r.redirect ?? "")).length;
    assert.equal(accepted, 1, `accepted ${accepted} of 6 concurrent submits against max_attempts=1`);
    assert.equal(await submissionCount(w), 1);
  });
});

test("F37: the cap holds across attempts: max_attempts submissions, then the history page", { skip }, async () => {
  await withQuiz({ maxAttempts: 2 }, async (w) => {
    signIn(w.userId);
    await takeQuiz(w, answerAll(w, 1));
    await takeQuiz(w, answerAll(w, 1));
    const third = await openRunner(w);
    assert.equal(third.redirect, `/quizzes/${w.slug}/history?error=attempts_exhausted`);
    assert.equal(await submissionCount(w), 2);
  });
});

test("F37: an overtime submit lands on the history page with the reason, and starts no new attempt", { skip }, async () => {
  await withQuiz({ timeLimitSeconds: 60 }, async (w) => {
    signIn(w.userId);
    const { runner } = await openRunner(w);
    await backdateOpenAttempt(w, 600);
    const res = await submit(runner, answerAll(w, 0));
    // It used to redirect back to the runner, whose render opened a FRESH
    // attempt with the full limit under a runner still holding the answers --
    // and the runner's next tick submitted them into it, scored.
    assert.equal(res.redirect, `/quizzes/${w.slug}/history?error=time_expired`);
    const { default: History } = await historyModule();
    const html = renderSync(
      await History({ params: Promise.resolve({ slug: w.slug }), searchParams: Promise.resolve({ error: "time_expired" }) }),
    );
    assert.match(html, /time ran out/i);
    assert.equal(await openAttempts(w), 0, "following the redirect must not start the clock on a new attempt");
    assert.equal(await submissionCount(w), 0);
  });
});

test("F37: an administrator can set the attempt cap in the quiz editor", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(randomUUID(), "programme_admin");
    const { saveQuizSchema } = await editorActions();
    const saved = await saveQuizSchema(w.quizId, JSON.stringify({ maxAttempts: 2 }));
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal((await w.q<{ m: number | null }>(`SELECT max_attempts AS m FROM quizzes WHERE id = $1`, [w.quizId]))[0]!.m, 2);
    const bad = await saveQuizSchema(w.quizId, JSON.stringify({ maxAttempts: 50 }));
    assert.equal(bad.ok, false, "the DB allows 1..20; the editor must say so rather than fail the UPDATE");
    // The editor shows the current value, so it can be changed back.
    const { default: Editor } = await editorPage();
    const html = renderSync(withAppRouter(await Editor({ params: Promise.resolve({ id: w.quizId }) })));
    assert.match(html, /&quot;maxAttempts&quot;: 2/);
  });
});

// ── F37: the runner's clock, driven with real effects and mocked timers ─────
//
// _ui.ts's mount() does not run effects, and the countdown is an effect. This
// is the same minimal hook dispatcher with effects recorded, so a test can run
// them and then drive setInterval and Date with node:test's mock timers.

function mountLive<P>(component: (props: P) => unknown, props: P) {
  const internals = (React as unknown as Record<string, { H: unknown } | undefined>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
  const slots: unknown[] = [];
  const effects: Array<{ fn: () => unknown; deps?: unknown[]; ran?: unknown[] | true; cleanup?: unknown }> = [];
  let cursor = 0;
  const slot = <T,>(init: () => T): [number, T] => {
    const k = cursor++;
    if (!(k in slots)) slots[k] = init();
    return [k, slots[k] as T];
  };
  const effect = (fn: () => unknown, deps?: unknown[]) => {
    const k = cursor++;
    effects[k] = { ...(effects[k] ?? {}), fn, deps };
  };
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const [k, value] = slot(() => (typeof initial === "function" ? (initial as () => T)() : initial));
      return [value, (next: T | ((p: T) => T)) => {
        slots[k] = typeof next === "function" ? (next as (p: T) => T)(slots[k] as T) : next;
      }];
    },
    useRef<T>(initial: T) { return slot(() => ({ current: initial }))[1]; },
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect() { cursor++; },
    useCallback<T>(fn: T) { cursor++; return fn; },
    useMemo<T>(fn: () => T) { cursor++; return fn(); },
    useTransition() { cursor++; return [false, (fn: () => void) => fn()]; },
    useContext(ctx: { _currentValue: unknown }) { return ctx._currentValue; },
    useId() { return `live-${cursor++}`; },
    useDebugValue() {},
  };
  let tree: unknown;
  const render = () => {
    const previous = internals.H;
    internals.H = dispatcher;
    cursor = 0;
    try {
      tree = component(props);
    } finally {
      internals.H = previous;
    }
    // Commit: run each effect whose deps changed (all of them, the first time).
    for (const e of effects) {
      if (!e) continue;
      const changed = e.ran === undefined || !e.deps || e.deps.some((d, i) => d !== (e.ran as unknown[])[i]);
      if (!changed) continue;
      if (typeof e.cleanup === "function") (e.cleanup as () => void)();
      e.cleanup = e.fn();
      e.ran = e.deps ?? true;
    }
    return tree;
  };
  render();
  return {
    rerender: render,
    text: () => hostElements(tree).map((el) => textOf(el)).join(" "),
    unmount: () => effects.forEach((e) => typeof e?.cleanup === "function" && (e.cleanup as () => void)()),
  };
}

const RUNNER_QUESTIONS = [{ id: "q1", prompt: "One?", options: ["a", "b"] }];
async function runners() {
  const { QuizRunner } = await import("../../apps/web/src/components/quiz/QuizRunner.tsx");
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  return [["QuizRunner", QuizRunner], ["MobileQuizRunner", MobileQuizRunner]] as const;
}
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * Date.now and setInterval under the test's hand. `tick` advances the clock
 * and runs intervals that fall due, as a browser does; `sleep` advances the
 * clock and holds every interval back by the same amount, which is what a
 * locked phone screen or a throttled background tab does to timers. (node:test
 * mock.timers can do neither: setting its clock runs every due timer, and its
 * intervals ignore a clearInterval from inside their own callback.)
 */
function fakeClock() {
  const g = globalThis as unknown as Record<string, unknown>;
  const real = { now: Date.now, setInterval: g.setInterval, clearInterval: g.clearInterval };
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; every: number; next: number }>();
  Date.now = () => now;
  g.setInterval = (fn: () => void, every: number) => {
    timers.set(++seq, { fn, every, next: now + every });
    return seq;
  };
  g.clearInterval = (id: number) => void timers.delete(id);
  return {
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.next;
        t.fn();
        if (timers.has(id)) t.next += t.every;
      }
      now = end;
    },
    sleep(ms: number) {
      now += ms;
      for (const t of timers.values()) t.next += ms;
    },
    restore() {
      Date.now = real.now;
      g.setInterval = real.setInterval;
      g.clearInterval = real.clearInterval;
    },
  };
}

test("F37: the runner auto-submits once at 00:00 and does not fire again when that submit is refused", async () => {
  for (const [name, Runner] of await runners()) {
    const clock = fakeClock();
    try {
      const calls: unknown[] = [];
      // A refused auto-submit: the action's promise rejects (as it does when
      // the server redirects the learner away).
      const submitAction = async (_slug: string, answers: unknown) => {
        calls.push(answers);
        throw new Error("refused");
      };
      const live = mountLive(Runner as never, { slug: "s", title: "T", questions: RUNNER_QUESTIONS, timeLimitSeconds: 2, submitAction } as never);
      for (let i = 0; i < 6; i++) {
        clock.tick(1000);
        await flush();
        live.rerender();
      }
      assert.equal(calls.length, 1, `${name} re-sent the answers ${calls.length} times after its auto-submit was refused`);
      live.unmount();
    } finally {
      clock.restore();
    }
  }
});

test("F37: the countdown follows the deadline, so a phone that slept shows the time actually left", async () => {
  for (const [name, Runner] of await runners()) {
    const clock = fakeClock();
    try {
      const live = mountLive(Runner as never, { slug: "s", title: "T", questions: RUNNER_QUESTIONS, timeLimitSeconds: 60, submitAction: async () => undefined } as never);
      clock.tick(1000);
      live.rerender();
      assert.match(live.text(), /00:59/, `${name} after one second`);
      // The screen locks for 30 s: the interval does not run, the clock does.
      clock.sleep(30_000);
      clock.tick(1000);
      live.rerender();
      // 1 s + 30 s asleep + 1 s = 32 s of a 60 s limit.
      assert.match(live.text(), /00:28/, `${name} counted ticks instead of time: ${live.text().match(/\d\d:\d\d/)?.[0]}`);
      live.unmount();
    } finally {
      clock.restore();
    }
  }
});

// ── F38: the editor and a payload without questions ──────────────────────────

const questionCount = async (w: QuizWorld) =>
  (await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM quiz_questions WHERE quiz_id = $1`, [w.quizId]))[0]!.n;

test("F38: saving settings without a questions array leaves the questions alone", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(randomUUID(), "programme_admin");
    const { saveQuizSchema } = await editorActions();
    // Taking a quiz offline is exactly this payload.
    const saved = await saveQuizSchema(w.quizId, JSON.stringify({ active: false }));
    assert.deepEqual(saved, { ok: true, questionCount: 3 }, "the editor reported the questions it deleted as saved");
    assert.equal(await questionCount(w), 3);
    assert.equal((await w.q<{ active: boolean }>(`SELECT active FROM quizzes WHERE id = $1`, [w.quizId]))[0]!.active, false);
  });
});

test("F38: an explicit empty questions array is refused once learners have submitted", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(w.userId);
    await takeQuiz(w, answerAll(w, 0));
    signIn(randomUUID(), "programme_admin");
    const { saveQuizSchema } = await editorActions();
    const saved = await saveQuizSchema(w.quizId, JSON.stringify({ questions: [] }));
    assert.equal(saved.ok, false, "emptying a quiz learners have sat orphans every result's review");
    assert.equal(await questionCount(w), 3);
  });
});

// ── F72: a result keeps the questions the learner was asked ──────────────────

test("F72: inserting a question on a live quiz does not rewrite a past result", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(w.userId);
    const submissionId = await takeQuiz(w, answerAll(w, 0));
    const before = await resultHtml(w, submissionId);
    assert.match(before, /3 correct/);

    // The editor keys rows by position, so a warm-up inserted first rewrites
    // question 1's row as the warm-up, 2 as the old 1, and so on.
    signIn(randomUUID(), "programme_admin");
    const { saveQuizSchema } = await editorActions();
    const saved = await saveQuizSchema(
      w.quizId,
      JSON.stringify({
        questions: [
          { prompt: `Warm-up ${w.t}`, options: ["x", "y"], correctIndex: 1 },
          ...[1, 2, 3].map((n) => ({
            prompt: `Question ${n} ${w.t}`,
            options: [`KEY-${n}-${w.t}`, `wrong-${n}-a`, `wrong-${n}-b`],
            correctIndex: 0,
            explanation: `EXPLAIN-${n}-${w.t}`,
          })),
        ],
      }),
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));

    signIn(w.userId);
    const after = await resultHtml(w, submissionId);
    assert.doesNotMatch(after, /Warm-up/, "the result shows a question the learner was never asked");
    assert.match(after, /3 of 3 answered/);
    assert.match(after, /3 correct/, "a 100% result now contradicts its own breakdown");
    for (const n of [1, 2, 3]) assert.match(after, new RegExp(`Question ${n} ${w.t}`));
  });
});

test("F72: rewording a question does not change what a past result says was asked", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(w.userId);
    const submissionId = await takeQuiz(w, answerAll(w, 0));
    signIn(randomUUID(), "programme_admin");
    const { saveQuizSchema } = await editorActions();
    await saveQuizSchema(
      w.quizId,
      JSON.stringify({
        questions: [1, 2, 3].map((n) => ({
          prompt: `Reworded ${n}`,
          options: ["p", "q", `KEY-${n}-${w.t}`],
          correctIndex: 2,
        })),
      }),
    );
    signIn(w.userId);
    const after = await resultHtml(w, submissionId);
    assert.doesNotMatch(after, /Reworded/);
    assert.match(after, /3 correct/, "moving correctIndex re-graded history while the stored score stayed 100");
  });
});

test("F72: the editor says learners have sat the quiz before anyone edits it", { skip }, async () => {
  await withQuiz({}, async (w) => {
    signIn(w.userId);
    await takeQuiz(w, answerAll(w, 0));
    signIn(randomUUID(), "programme_admin");
    const { default: Editor } = await editorPage();
    const html = renderSync(withAppRouter(await Editor({ params: Promise.resolve({ id: w.quizId }) })));
    assert.match(html, /data-testid="quiz-editor-submissions"[^>]*>1 submitted attempt\./);
  });
});

test("F72: migration 0030 gives an existing submission the questions its quiz has now", { skip }, async () => {
  const { readFileSync } = await import("node:fs");
  const sqlText = readFileSync(
    new URL("../../packages/db/src/migrations/0030_quiz_submission_question_snapshot.sql", import.meta.url),
    "utf8",
  );
  const backfill = sqlText.split("--> statement-breakpoint").find((s) => /UPDATE "quiz_submissions"/.test(s))!;
  await rolledBack(async (c) => {
    const t = tag("qsnap");
    const subjectId = await rttSubject(c, t);
    const user = (await c.query(`INSERT INTO users (id, email, role) VALUES (gen_random_uuid(), $1, 'teacher') RETURNING id`, [`${t}@example.test`])).rows[0].id;
    const quiz = (await c.query(`INSERT INTO quizzes (slug, title, rtt_subject_id) VALUES ($1, 'Q', $2) RETURNING id`, [t, subjectId])).rows[0].id;
    const q1 = (await c.query(`INSERT INTO quiz_questions (quiz_id, sequence, prompt, options, correct_index) VALUES ($1, 1, 'P1', '["a","b"]', 1) RETURNING id`, [quiz])).rows[0].id;
    // A submission written before the column existed.
    const sub = (await c.query(`INSERT INTO quiz_submissions (quiz_id, user_id, answers, score, passed) VALUES ($1, $2, '[]', 0, false) RETURNING id`, [quiz, user])).rows[0].id;
    await c.query(backfill);
    const snap = (await c.query(`SELECT question_snapshot FROM quiz_submissions WHERE id = $1`, [sub])).rows[0].question_snapshot;
    assert.deepEqual(snap, [{ id: q1, prompt: "P1", options: ["a", "b"], correctIndex: 1, explanation: null }]);
  });
});
