// /quizzes/[slug] — multiple-choice quiz runner.
// Revives spec 079 (dropped in Phase 8) per the Workflow Run 10 frontend-parity
// audit. Server component loads the quiz + questions, then hands them to the
// <QuizRunner> client component. Submit handler is a Server Action that grades
// the attempt, persists a `quiz_submissions` row, audits `quiz.submit`, and
// redirects to /quizzes/[slug]/result/[submissionId].
//
// JSX prototype reference: LMS GML Frontend/forms.jsx::QuizRunner (lines 157-266).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  quizAttempts,
  quizQuestions,
  quizSubmissions,
  quizzes,
} from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { getDeviceType } from "@/lib/device";
import { isUuid } from "@/lib/ids";
import { QuizRunner } from "@/components/quiz/QuizRunner";
import { MobileQuizRunner } from "@/components/quiz/MobileQuizRunner";
import { quizShownTo } from "./quiz-scope";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quiz" };

// Seconds past the time limit a submission is still scored. It exists for the
// time the learner did NOT see: the auto-submit at 00:00 still has to travel
// back, and the interval that fires it can be a second late. On a Ladakh 2G
// link that is seconds, and penalising it would be penalising someone's
// bandwidth. It is applied HERE ONLY -- the countdown shows the real limit --
// because a grace that is also on the clock is no grace at all.
//
// It no longer has to cover the page's own load. The countdown used to start
// when the runner mounted, so delivery and hydration came out of this grace
// -- seconds on a warm cache, but a cold first load on 2G can take longer
// than 30 s, and then every answer was refused. The runner now takes that
// time off the countdown (components/quiz/deadline.ts, W3-18), except when
// the phone's clock is too far from the database's to tell latency from a
// wrong clock; then the load is paid from here, as before.
const SUBMIT_GRACE_SECONDS = 30;

/**
 * The audit row for an attempt closed because its time ran out, by either
 * path. entity_type is the table's name, as quiz.created and
 * quiz.schema.update write it; this row said 'quiz', so an export filtered
 * by entity type found one set or the other, never both (W3-23).
 */
function auditExpired(quiz: { id: string; timeLimitSeconds: number | null }, slug: string): void {
  void recordAudit({
    action: "quiz.attempt.expired",
    entityType: "quizzes",
    entityId: quiz.id,
    metadata: { quizSlug: slug, limitSeconds: quiz.timeLimitSeconds },
  });
}

// ---------------------------------------------------------------------------
// Server action — wired into <QuizRunner> via the `submitAction` prop.
// Computes percentage-correct, inserts the submission, fires audit, redirects.
// ---------------------------------------------------------------------------

export async function submitQuizAttempt(
  slug: string,
  // The attempt the runner was rendered for (quiz_attempts.id). See the
  // transaction below for why a submit names it.
  attemptId: string,
  answers: Array<{ questionId: string; selectedIndex: number | null }>,
): Promise<void> {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // Load the quiz by slug (active, and on a subject this learner is shown:
  // a runner opened before its subject was retired cannot still submit --
  // quiz-scope.ts, W3-21).
  const [quiz] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);
  if (!quiz || !quiz.active || !(await quizShownTo(db, { id: userId, role: session.user.role }, quiz))) {
    redirect(`/quizzes/${slug}?error=not_found`);
  }

  // Load questions ordered by sequence.
  const qs = await db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(asc(quizQuestions.sequence));

  // Spec 146 — grading-bug fix.
  // The denominator MUST be the count of questions stored in the DB,
  // NOT the count of answers the client posted. Before this fix the
  // client filtered to "answered only" before submitting, so a learner
  // who answered 3/10 questions correctly was scored 100% — the server
  // graded against the 3 they answered, not the 10 in the DB.
  // Now: skipped questions arrive as `selectedIndex: null` (or are
  // absent from the map for defensive back-compat), and BOTH cases
  // count as wrong (0 points). The learner had the chance to answer
  // and chose not to — same outcome as picking the wrong option.
  //
  // WHAT IS STORED IS WHAT WAS GRADED. `answers` is whatever the client
  // POSTed, and it used to be inserted verbatim: extra keys, ids of questions
  // not in this quiz, a 200 kB string as a selectedIndex, thousands of junk
  // entries -- none of it changed the score, all of it became the permanent
  // record of what the learner answered, and the result page printed it back
  // ("(option <whatever was sent>)"). So it is rebuilt from this quiz's own
  // questions: one entry each, in order, the pick kept only if it is a whole
  // number naming one of that question's options, and null (skipped)
  // otherwise. A non-array is no answers, not a TypeError.
  const posted = new Map<string, unknown>();
  for (const a of Array.isArray(answers) ? (answers as unknown[]) : []) {
    if (a && typeof a === "object" && typeof (a as { questionId?: unknown }).questionId === "string") {
      const entry = a as { questionId: string; selectedIndex?: unknown };
      posted.set(entry.questionId, entry.selectedIndex);
    }
  }
  const recorded = qs.map((q) => {
    const raw = posted.get(q.id);
    const optionCount = Array.isArray(q.options) ? q.options.length : 0;
    const selectedIndex =
      typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < optionCount ? raw : null;
    return { questionId: q.id, selectedIndex };
  });
  const answerMap = new Map(
    recorded.map((a) => [a.questionId, a.selectedIndex] as const),
  );
  let correct = 0;
  let answeredCount = 0;
  for (const q of qs) {
    const picked = answerMap.get(q.id);
    if (picked !== undefined && picked !== null) {
      answeredCount += 1;
      if (picked === q.correctIndex) correct += 1;
    }
  }
  const score = qs.length === 0 ? 0 : Math.round((correct / qs.length) * 100);
  const passed = score >= quiz.passThreshold;

  // ── ATTEMPT CAP AND TIME LIMIT, SERVER-SIDE ────────────────────────────────
  //
  // Both were enforced only in the browser, and the time limit could not have
  // been enforced anywhere else: quiz_submissions recorded submitted_at and
  // nothing else, so the server had no attempt start to measure against. The
  // countdown is an interval in a component; this action is a URL.
  //
  // The cap is checked against COMPLETED submissions, not attempts, because an
  // abandoned attempt (closed the tab, lost connectivity on the way home from
  // school) must not consume one of a learner's tries.
  //
  // ── ONE OPEN ATTEMPT, ONE SUBMISSION, IN ONE TRANSACTION ──────────────────
  //
  // This was four separate statements -- count, look up the open attempt,
  // insert, close -- and a submission without an open attempt was scored with
  // no time check at all. So six concurrent POSTs (a double tap on a slow
  // link, two tabs) all passed a cap of two, and a second tab submitted after
  // the first had closed the attempt was accepted however long it had been
  // open.
  //
  // Now the FIRST statement closes the learner's open attempt and returns it.
  // The row lock makes concurrent submits queue behind it; each one after the
  // first finds the attempt closed and is refused. No open attempt, no
  // submission. The cap is counted inside the same transaction, and cannot be
  // raced across attempts either: quiz_attempts_one_open_uq makes a new
  // attempt wait for this transaction before it can open.
  //
  // THE ATTEMPT THE RUNNER WAS RENDERED FOR, NOT WHICHEVER IS OPEN (W3-19).
  // The submit named no attempt, so it closed whatever attempt was open when
  // it arrived. A runner left open on an earlier attempt -- the desktop tab
  // after the learner submitted on the phone and pressed Retake -- then
  // auto-submitted its blank answers at 00:00 into the retake: scored, the
  // learner's last try gone, and their real answers refused as
  // attempt_closed. The page hands each runner its attempt's id, and only
  // that attempt, still open and still this learner's, can be closed here.
  const result = await db.transaction(async (tx) => {
    if (!isUuid(attemptId)) return { kind: "attempt_closed" } as const;
    const [attempt] = await tx
      .update(quizAttempts)
      .set({ closedAt: sql`now()` })
      .where(
        and(
          eq(quizAttempts.id, attemptId),
          eq(quizAttempts.quizId, quiz.id),
          eq(quizAttempts.userId, userId),
          isNull(quizAttempts.closedAt),
        ),
      )
      // Elapsed time is measured by Postgres, the clock that wrote
      // started_at -- as the page does below -- not by this process's clock.
      .returning({
        id: quizAttempts.id,
        elapsedSeconds: sql<number>`EXTRACT(EPOCH FROM (now() - ${quizAttempts.startedAt}))::float8`,
      });
    if (!attempt) return { kind: "attempt_closed" } as const;

    // Over time: the attempt stays closed (this transaction commits), so it
    // is recorded rather than silently discarded -- an over-time submission
    // is a fact about the learner's attempt.
    if (
      quiz.timeLimitSeconds != null &&
      attempt.elapsedSeconds > quiz.timeLimitSeconds + SUBMIT_GRACE_SECONDS
    ) {
      return { kind: "time_expired" } as const;
    }

    if (quiz.maxAttempts != null) {
      const [prior] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(quizSubmissions)
        .where(and(eq(quizSubmissions.quizId, quiz.id), eq(quizSubmissions.userId, userId)));
      if ((prior?.n ?? 0) >= quiz.maxAttempts) return { kind: "attempts_exhausted" } as const;
    }

    const [inserted] = await tx
      .insert(quizSubmissions)
      .values({
        quizId: quiz.id,
        userId,
        answers: recorded,
        // The questions this was graded against, so the result keeps meaning
        // the same thing after the quiz is edited (migration 0030).
        questionSnapshot: qs.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          options: Array.isArray(q.options) ? q.options : [],
          correctIndex: q.correctIndex,
          explanation: q.explanation ?? null,
        })),
        score,
        passed,
      })
      .returning({ id: quizSubmissions.id });
    await tx
      .update(quizAttempts)
      .set({ submissionId: inserted!.id })
      .where(eq(quizAttempts.id, attempt.id));
    return { kind: "submitted", submissionId: inserted!.id } as const;
  });

  // Refusals land on the history page, NOT back on the runner. Rendering the
  // runner opens a fresh attempt with the full limit, and after a time_expired
  // the still-mounted runner submitted the same answers into it on its next
  // tick -- scored. The history page says why, shows past scores, and starts
  // nothing until the learner chooses "Take quiz again".
  if (result.kind === "time_expired") auditExpired(quiz, slug);
  if (result.kind !== "submitted") redirect(`/quizzes/${slug}/history?error=${result.kind}`);
  const submissionId = result.submissionId;

  void recordAudit({
    action: "quiz.submit",
    entityType: "quiz_submission",
    entityId: submissionId,
    metadata: {
      quizSlug: slug,
      score,
      passed,
      questionCount: qs.length,
      // Spec 146 — emit `answeredCount` so the audit trail can
      // distinguish "answered X / N correctly" from "skipped N - X".
      answeredCount,
    },
  });

  redirect(`/quizzes/${slug}/result/${submissionId}`);
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function QuizRunnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { slug } = await params;

  const [quiz] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);

  // A quiz on an RTT subject this viewer is not shown -- retired, or taught
  // in another district or zone -- is treated as not there, as /rtt and the
  // subject page treat it; a direct link used to open it (quiz-scope.ts,
  // W3-21).
  if (
    !quiz ||
    !quiz.active ||
    !(await quizShownTo(db, { id: session.user.id, role: session.user.role }, quiz))
  ) {
    // submitQuizAttempt sends a learner here with ?error=not_found when the
    // quiz was switched off (or removed) while they were answering it. This
    // check used to run first and 404 them, so the message written for
    // exactly that case could never be shown: they lost their answers to a
    // bare "page not found". Say what happened; serve nothing else.
    const sp = searchParams ? await searchParams : {};
    if (sp.error === "not_found") {
      return (
        <main>
          <p
            role="alert"
            data-testid="quiz-error"
            style={{
              margin: "12px 16px 0",
              padding: "10px 12px",
              border: "1px solid var(--saffron)",
              background: "var(--saffron-soft)",
              borderRadius: "var(--r-2, 8px)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            That quiz is no longer available, so these answers could not be recorded.
          </p>
          <div className="page-header">
            <Link href="/dashboard" className="btn btn-sm" style={{ textDecoration: "none" }}>
              ← Dashboard
            </Link>
          </div>
        </main>
      );
    }
    notFound();
  }

  const questions = await db
    .select({
      id: quizQuestions.id,
      sequence: quizQuestions.sequence,
      prompt: quizQuestions.prompt,
      options: quizQuestions.options,
    })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(asc(quizQuestions.sequence));

  // ── OPEN AN ATTEMPT ────────────────────────────────────────────────────────
  //
  // This is what the server-side time limit measures against. Without a record
  // of when the attempt started, `quizzes.time_limit_seconds` could only ever
  // be a countdown in the browser -- a setTimeout in a component, against a
  // submit action that is a URL.
  //
  // IDEMPOTENT ON PURPOSE. A server component can render more than once for a
  // single visit, and a learner may reload or open a second tab. The partial
  // unique index (user_id, quiz_id) WHERE closed_at IS NULL absorbs all of
  // that, so the FIRST load starts the clock and every subsequent one is a
  // no-op -- rather than each reload quietly granting a fresh time limit.
  //
  // Refuse to start one at all when the learner has no attempts left, so they
  // are told before they answer thirty questions rather than after.
  let attemptsUsed = 0;
  if (quiz.maxAttempts != null) {
    const prior = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(quizSubmissions)
      .where(
        and(eq(quizSubmissions.quizId, quiz.id), eq(quizSubmissions.userId, session.user.id)),
      );
    attemptsUsed = prior[0]?.n ?? 0;
    if (attemptsUsed >= quiz.maxAttempts) {
      redirect(`/quizzes/${slug}/history?error=attempts_exhausted`);
    }
  }

  await db
    .insert(quizAttempts)
    .values({ quizId: quiz.id, userId: session.user.id })
    .onConflictDoNothing();

  // THE COUNTDOWN MUST CONTINUE THE ATTEMPT, NOT RESTART IT.
  //
  // The runner was handed `timeLimitSeconds` and nothing else, so it started a
  // fresh countdown from the FULL limit on every render -- while the server
  // measures elapsed time from quiz_attempts.startedAt, which is set once when
  // the attempt opens. A learner who reloaded the page, lost their connection
  // and came back, or simply reopened the tab saw the whole time again,
  // answered in good faith, and was rejected with ?error=time_expired at
  // submit. On a Ladakh connection a dropped page is ordinary, so this is the
  // normal path, not an edge case.
  //
  // Reading the attempt back and passing what is actually LEFT makes the
  // countdown agree with the rule it is displaying. Clamped at zero rather
  // than going negative.
  //
  // WITHOUT the submit grace. This used to add the +30s here too "so a learner
  // is never shown less time than the server will honour" -- which spent the
  // whole grace on the clock: the countdown reached 00:00 exactly at the
  // server's cut-off, so the auto-submit, arriving a page-load and an upload
  // later, was refused as time_expired and every answer was discarded. The
  // learner sees the limit; the grace covers the latency they cannot see.
  //
  // Elapsed time comes from POSTGRES, not from this process.
  //
  // started_at is a database timestamp, so measuring against the app
  // server's clock introduces a second source of truth that drifts -- and on
  // a countdown a learner is being graded against, drift means being cut off
  // early. now() - started_at uses one clock for both ends. It also keeps
  // this Server Component free of Date.now(), which React's purity rule
  // flags in a component body.
  const [attempt] = await db
    .select({
      id: quizAttempts.id,
      elapsedSeconds: sql<number>`EXTRACT(EPOCH FROM (now() - ${quizAttempts.startedAt}))::int`,
      // The same clock at the same moment, for the runner to measure how long
      // this page took to reach it (components/quiz/deadline.ts).
      serverNowMs: sql<number>`(EXTRACT(EPOCH FROM now()) * 1000)::float8`,
    })
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.quizId, quiz.id),
        eq(quizAttempts.userId, session.user.id),
        isNull(quizAttempts.closedAt),
      ),
    )
    .limit(1);
  let remainingSeconds: number | null = quiz.timeLimitSeconds ?? null;
  if (remainingSeconds != null && attempt) {
    remainingSeconds = Math.max(
      0,
      Math.round(remainingSeconds - (attempt.elapsedSeconds ?? 0)),
    );
  }

  // NO TIME LEFT: NO RUNNER.
  //
  // A runner handed 0 seconds showed 00:00 and auto-submitted on its first
  // tick whatever it held -- nothing, after the reload that brought the
  // learner here. Inside the grace that blank was scored, and on a capped quiz
  // it used up an attempt the learner never acted on; after the grace it was
  // refused, so coming back later cost nothing. The learner who came back
  // sooner was the one penalised. Nobody can answer in no time, so no runner
  // is mounted; the history page says why.
  //
  //  - Past the grace, no submit can be scored any more, so the attempt is
  //    closed here and recorded as the submit path records it. Postgres's
  //    clock decides, as it does at submit. This is also what closes an
  //    attempt abandoned past its deadline: it stays open until the learner
  //    comes back, and used to be closed by a runner flashing 00:00.
  //  - Inside the grace it is left open: an auto-submit already on its way
  //    from the tab that timed out (the 2G case the grace exists for) must
  //    still be scored, not refused as attempt_closed.
  if (quiz.timeLimitSeconds != null && attempt && remainingSeconds === 0) {
    if (attempt.elapsedSeconds > quiz.timeLimitSeconds + SUBMIT_GRACE_SECONDS) {
      const closed = await db
        .update(quizAttempts)
        .set({ closedAt: sql`now()` })
        .where(
          and(
            eq(quizAttempts.id, attempt.id),
            isNull(quizAttempts.closedAt),
            sql`now() - ${quizAttempts.startedAt} > make_interval(secs => ${quiz.timeLimitSeconds + SUBMIT_GRACE_SECONDS})`,
          ),
        )
        .returning({ id: quizAttempts.id });
      if (closed.length > 0) auditExpired(quiz, slug);
      redirect(`/quizzes/${slug}/history?error=time_expired`);
    }
    redirect(`/quizzes/${slug}/history?error=time_up`);
  }

  // Spec 134 — device-aware runner. Mobile gets the full-screen
  // one-question-per-screen layout from mobile-runners.jsx::MobQuiz.
  // Same grading contract (submitQuizAttempt) — drop-in replacement.
  const device = await getDeviceType();

  const mappedQuestions = questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
  }));

  // Spec 159 — optional per-quiz time-limit. The schema field is NULLABLE
  // and the legacy seed quizzes all carry NULL, so this prop is opt-in
  // and existing learners see no change. When set, the runner renders
  // a countdown banner and auto-submits at 00:00.
  // The countdown the runner renders: seconds REMAINING on the open attempt,
  // not the quiz's full limit. See the attempt read above.
  const timeLimitSeconds = remainingSeconds;

  // WHERE A REFUSED SUBMIT IS EXPLAINED. This page no longer carries error
  // banners for an active quiz: refused attempts (out of time, no attempts
  // left, already submitted) go to the history page, which explains them
  // without opening a new attempt, and a quiz that has gone is explained by
  // the inactive-quiz branch above. See the redirects in submitQuizAttempt.

  // Keyed by the attempt: a different attempt is a different runner, with
  // fresh selections and a fresh clock. Without the key React kept the old
  // runner's state -- answers and a countdown already at zero -- across a
  // re-render that brought a new attempt.
  const runnerKey = attempt?.id ?? "no-attempt";
  // And the attempt its submit closes (see submitQuizAttempt). None is "",
  // which the action refuses as attempt_closed.
  const attemptId = attempt?.id ?? "";

  if (device === "mobile") {
    return (
      <main>
        <MobileQuizRunner
          key={runnerKey}
          slug={slug}
          title={quiz.title}
          questions={mappedQuestions}
          timeLimitSeconds={timeLimitSeconds}
          attemptId={attemptId}
          userId={session.user.id}
          serverNowMs={attempt?.serverNowMs ?? null}
          submitAction={submitQuizAttempt}
        />
      </main>
    );
  }

  return (
    <main>
      <div className="page-header" style={{ paddingBottom: 0 }}>
        <Link
          href="/dashboard"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 6, textDecoration: "none" }}
        >
          ← Dashboard
        </Link>
      </div>
      <QuizRunner
        key={runnerKey}
        slug={slug}
        title={quiz.title}
        questions={mappedQuestions}
        timeLimitSeconds={timeLimitSeconds}
        attemptId={attemptId}
        userId={session.user.id}
        serverNowMs={attempt?.serverNowMs ?? null}
        submitAction={submitQuizAttempt}
      />
    </main>
  );
}
