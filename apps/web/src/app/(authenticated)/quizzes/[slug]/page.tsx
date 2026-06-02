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
import { asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  quizzes,
  quizQuestions,
  quizSubmissions,
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
