// /quizzes/[slug] — multiple-choice quiz runner.
// Revives spec 079 (dropped in Phase 8) per the Workflow Run 10 frontend-parity
// audit. Server component loads the quiz + questions, then hands them to the
// <QuizRunner> client component. Submit handler is a Server Action that grades
// the attempt, persists a `quiz_submissions` row, audits `quiz.submit`, and
// redirects to /quizzes/[slug]/result/[submissionId].
//
// JSX prototype reference: LMS GML Frontend/forms.jsx::QuizRunner (lines 157-266).

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
import { QuizRunner } from "@/components/quiz/QuizRunner";
import { MobileQuizRunner } from "@/components/quiz/MobileQuizRunner";

export const dynamic = "force-dynamic";

// Seconds past the time limit a submission is still scored. It exists for the
// time the learner did NOT see: the countdown starts only once the page has
// arrived and hydrated, and the auto-submit at 00:00 still has to travel back.
// On a Ladakh 2G link that is seconds, and penalising it would be penalising
// someone's bandwidth. It is applied HERE ONLY -- the countdown shows the real
// limit -- because a grace that is also on the clock is no grace at all.
const SUBMIT_GRACE_SECONDS = 30;

// ---------------------------------------------------------------------------
// Server action — wired into <QuizRunner> via the `submitAction` prop.
// Computes percentage-correct, inserts the submission, fires audit, redirects.
// ---------------------------------------------------------------------------

export async function submitQuizAttempt(
  slug: string,
  answers: Array<{ questionId: string; selectedIndex: number | null }>,
): Promise<void> {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // Load the quiz by slug (active only).
  const [quiz] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);
  if (!quiz || !quiz.active) redirect(`/quizzes/${slug}?error=not_found`);

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
  const answerMap = new Map(
    answers.map((a) => [a.questionId, a.selectedIndex] as const),
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
  // countdown is a setTimeout in a component; this action is a URL.
  //
  // The cap is checked against COMPLETED submissions, not attempts, because an
  // abandoned attempt (closed the tab, lost connectivity on the way home from
  // school) must not consume one of a learner's tries.
  if (quiz.maxAttempts != null) {
    const prior = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(quizSubmissions)
      .where(and(eq(quizSubmissions.quizId, quiz.id), eq(quizSubmissions.userId, userId)));
    if ((prior[0]?.n ?? 0) >= quiz.maxAttempts) {
      redirect(`/quizzes/${slug}?error=attempts_exhausted`);
    }
  }

  // The open attempt this submission belongs to, if any.
  // Elapsed time is measured by Postgres, the clock that wrote started_at --
  // as the page does below -- not by this process's Date.now().
  const [openAttempt] = await db
    .select({
      id: quizAttempts.id,
      elapsedSeconds: sql<number>`EXTRACT(EPOCH FROM (now() - ${quizAttempts.startedAt}))::float8`,
    })
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.quizId, quiz.id),
        eq(quizAttempts.userId, userId),
        isNull(quizAttempts.closedAt),
      ),
    )
    .limit(1);

  let overtime = false;
  if (quiz.timeLimitSeconds != null && openAttempt) {
    overtime = openAttempt.elapsedSeconds > quiz.timeLimitSeconds + SUBMIT_GRACE_SECONDS;
  }
  if (overtime) {
    // The attempt is closed and recorded, not silently discarded: an
    // over-time submission is a fact about the learner's attempt, and dropping
    // it would leave them with no record of having sat the quiz at all.
    await db
      .update(quizAttempts)
      .set({ closedAt: new Date() })
      .where(eq(quizAttempts.id, openAttempt!.id));
    void recordAudit({
      action: "quiz.attempt.expired",
      entityType: "quiz",
      entityId: quiz.id,
      metadata: { quizSlug: slug, limitSeconds: quiz.timeLimitSeconds },
    });
    redirect(`/quizzes/${slug}?error=time_expired`);
  }

  const [inserted] = await db
    .insert(quizSubmissions)
    .values({
      quizId: quiz.id,
      userId,
      answers,
      score,
      passed,
    })
    .returning({ id: quizSubmissions.id });
  const submissionId = inserted?.id ?? "";

  if (openAttempt) {
    await db
      .update(quizAttempts)
      .set({ closedAt: new Date(), submissionId })
      .where(eq(quizAttempts.id, openAttempt.id));
  }

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

  if (!quiz || !quiz.active) {
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
  let remainingSeconds: number | null = quiz.timeLimitSeconds ?? null;
  if (remainingSeconds != null) {
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
        elapsedSeconds: sql<number>`EXTRACT(EPOCH FROM (now() - ${quizAttempts.startedAt}))::int`,
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
    if (attempt) {
      remainingSeconds = Math.max(
        0,
        Math.round(remainingSeconds - (attempt.elapsedSeconds ?? 0)),
      );
    }
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

  // RENDER THE REASON WE BOUNCED THEM BACK.
  //
  // submitQuizAttempt redirects here with ?error= when an attempt is refused,
  // and this page did not read searchParams at all — so a learner who ran out
  // of time or used their last attempt was silently returned to the quiz with
  // no explanation, looking at the questions they had just answered. They would
  // reasonably try again, and be refused again, with no way to find out why.
  const sp = searchParams ? await searchParams : {};
  const QUIZ_ERRORS: Record<string, string> = {
    time_expired:
      "Your time ran out before the answers reached us, so this attempt was not scored.",
    attempts_exhausted: "You have used all your attempts at this quiz.",
    not_found: "That quiz is no longer available.",
  };
  const errorMessage = sp.error ? QUIZ_ERRORS[sp.error] ?? null : null;

  const errorBanner = errorMessage ? (
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
      {errorMessage}
    </p>
  ) : null;

  if (device === "mobile") {
    return (
      <main>
        {errorBanner}
        <MobileQuizRunner
          slug={slug}
          title={quiz.title}
          questions={mappedQuestions}
          timeLimitSeconds={timeLimitSeconds}
          submitAction={submitQuizAttempt}
        />
      </main>
    );
  }

  return (
    <main>
      {errorBanner}
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
        slug={slug}
        title={quiz.title}
        questions={mappedQuestions}
        timeLimitSeconds={timeLimitSeconds}
        submitAction={submitQuizAttempt}
      />
    </main>
  );
}
