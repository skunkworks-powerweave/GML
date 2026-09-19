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
  const [openAttempt] = await db
    .select({ id: quizAttempts.id, startedAt: quizAttempts.startedAt })
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
    const elapsed = (Date.now() - openAttempt.startedAt.getTime()) / 1000;
    // A grace margin, because the limit is measured from a server timestamp
    // while the countdown the learner watched started a round-trip later. On a
    // Ladakh connection that difference is real, and penalising someone for it
    // would be penalising their bandwidth.
    overtime = elapsed > quiz.timeLimitSeconds + 30;
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
}: {
  params: Promise<{ slug: string }>;
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
  const timeLimitSeconds = quiz.timeLimitSeconds ?? null;

  if (device === "mobile") {
    return (
      <main>
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
