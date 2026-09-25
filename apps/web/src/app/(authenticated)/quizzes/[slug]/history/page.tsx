// /quizzes/[slug]/history — quiz attempts history for the current user.
//
// Spec 159 — Workflow Run 15 audit-closure MISS: until now, a learner who
// retook a quiz had no way to look back at their prior attempts. The
// result page (/quizzes/[slug]/result/[submissionId]) shows ONE attempt
// at a time, and the only way to find an old submission was to scroll the
// dashboard "needs your attention" feed or pull the row out of the audit
// log. This page closes the gap with a per-user, newest-first list of
// quiz_submissions for the requested quiz, with each row linking to its
// own result detail page.
//
// Access contract:
//   - Server component; requires a logged-in user.
//   - Scope is implicitly the CURRENT user only — we never join across
//     users, so a teacher can't see another teacher's attempts here.
//     The result page (spec 120) already gates per-user; this page
//     mirrors that gate at the query layer (WHERE user_id = me).
//   - quizSubmissions is indexed on (user_id, submitted_at) per spec 120
//     so the ORDER BY submitted_at DESC scan is an index range scan,
//     not a seqscan.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { quizzes, quizSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Spec 159 — render a `submittedAt` Date as a deterministic ISO YYYY-MM-DD
// HH:MM string in UTC. We deliberately avoid `toLocaleString` here because
// the server's locale can disagree with the user's (server runs in UTC;
// the user might be in IST). The mono font + UTC-anchored slice is the
// least-surprising read-out across server-render + client-rehydrate.
function formatSubmittedAt(d: Date): string {
  const iso = d.toISOString();
  // "2026-06-01T14:32:11.123Z" → "2026-06-01 14:32"
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

type Props = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ error?: string }>;
};

export default async function QuizHistoryPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { slug } = await params;

  // The quiz runner redirects HERE with ?error=attempts_exhausted when a
  // learner opens a quiz they have no attempts left for — sending them
  // somewhere useful (their past scores) rather than a dead end. This page
  // read no searchParams, so they arrived at their history with no idea why
  // the quiz would not open.
  //
  // submitQuizAttempt sends every refused submission here too, rather than
  // back to the runner: rendering the runner opens a fresh attempt, and after
  // a time-out that let the still-mounted runner submit the same answers into
  // it. From here nothing starts until the learner presses "Take quiz again".
  const sp = searchParams ? await searchParams : {};
  const HISTORY_ERRORS: Record<string, string> = {
    attempts_exhausted:
      "You have used all your attempts at this quiz. Your previous scores are below.",
    time_expired:
      "Your time ran out before the answers reached us, so that attempt was not scored.",
    attempt_closed:
      "That attempt had already been submitted or closed, so those answers were not recorded again. Your attempts are below.",
  };
  const historyError = sp.error ? HISTORY_ERRORS[sp.error] ?? null : null;

  // Resolve the quiz first so we 404 cleanly for bad slugs (rather than
  // rendering an empty history page for a non-existent quiz).
  const [quiz] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);
  if (!quiz) notFound();

  const rows = await db
    .select({
      id: quizSubmissions.id,
      score: quizSubmissions.score,
      passed: quizSubmissions.passed,
      submittedAt: quizSubmissions.submittedAt,
    })
    .from(quizSubmissions)
    .where(
      and(
        eq(quizSubmissions.quizId, quiz.id),
        eq(quizSubmissions.userId, userId),
      ),
    )
    .orderBy(desc(quizSubmissions.submittedAt));

  // ARE THERE ATTEMPTS LEFT?
  //
  // Without this the page produced a loop. /quizzes/[slug] redirects HERE with
  // ?error=attempts_exhausted when the cap is reached, and both buttons on this
  // page linked straight back to /quizzes/[slug] -- which redirected here
  // again. A learner who had used their attempts could press "Take quiz again"
  // forever and never see anything change except the page flickering.
  //
  // The count is the same one the runner uses: submissions, not attempts, so an
  // abandoned attempt does not consume a try.
  const attemptsLeft =
    quiz.maxAttempts == null ? null : Math.max(0, quiz.maxAttempts - rows.length);
  const canRetake = attemptsLeft === null || attemptsLeft > 0;

  return (
    <main>
      {historyError ? (
        <p
          role="alert"
          data-testid="history-error"
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
          {historyError}
        </p>
      ) : null}
      <div className="page-header">
        <Link
          href={`/quizzes/${slug}`}
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 6, textDecoration: "none" }}
        >
          ← Quiz
        </Link>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
          Your attempts
        </h1>
        <p
          style={{
            color: "var(--ink-3)",
            marginTop: 4,
            fontSize: 13,
          }}
        >
          {quiz.title} · pass threshold {quiz.passThreshold}%
        </p>
      </div>

      <div className="page-body">
        {rows.length === 0 ? (
          <div
            data-testid="quiz-history-empty"
            className="card card-hi"
            style={{ padding: 32, textAlign: "center" }}
          >
            <h2 style={{ fontFamily: "var(--serif)", fontSize: 20, margin: 0 }}>
              No attempts yet
            </h2>
            <p style={{ color: "var(--ink-3)", marginTop: 8, fontSize: 13 }}>
              You haven&apos;t submitted this quiz yet. Start it to see your
              first attempt here.
            </p>
            {canRetake ? (
              <Link
                href={`/quizzes/${slug}`}
                className="btn btn-primary"
                style={{ marginTop: 16, textDecoration: "none" }}
              >
                Start the quiz
              </Link>
            ) : (
              <p style={{ marginTop: 16, fontSize: 13, color: "var(--ink-3)" }}>
                You have no attempts left at this quiz.
              </p>
            )}
          </div>
        ) : (
          // PHONE WIDTH (F11). This was an ARIA grid of divs with four
          // minmax(0, ...) columns at every width: on a phone the score,
          // result and "View result" columns were ~48 px each, narrower than
          // their contents, so the three ran into each other and the button
          // was cut off by the card's overflow:hidden. It is a table now, the
          // native semantics the divs imitated, and it scrolls sideways inside
          // its card when a phone is too narrow for it; the date links to the
          // result too, so the attempt can be opened from the row's left edge.
          <div
            data-testid="quiz-history-table"
            className="card card-hi"
            style={{ padding: 0, overflowX: "auto" }}
          >
            <table className="t" aria-label="Your quiz attempts">
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>Score</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} data-testid="quiz-history-row">
                    <td
                      style={{
                        padding: "12px 14px",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink)",
                        borderBottom:
                          i === rows.length - 1
                            ? "none"
                            : "1px solid var(--line)",
                      }}
                    >
                      <Link href={`/quizzes/${slug}/result/${r.id}`} style={{ color: "inherit" }}>
                        {formatSubmittedAt(r.submittedAt)}
                      </Link>
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        fontFamily: "var(--mono)",
                        fontSize: 14,
                        color: r.passed ? "var(--lichen)" : "var(--saffron)",
                        fontWeight: 600,
                        borderBottom:
                          i === rows.length - 1
                            ? "none"
                            : "1px solid var(--line)",
                      }}
                    >
                      {r.score}%
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        fontSize: 12,
                        borderBottom:
                          i === rows.length - 1
                            ? "none"
                            : "1px solid var(--line)",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontFamily: "var(--mono)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          background: r.passed
                            ? "var(--lichen-soft)"
                            : "var(--saffron-soft)",
                          color: r.passed ? "var(--lichen)" : "var(--saffron)",
                        }}
                      >
                        {r.passed ? "Pass" : "Retry"}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        textAlign: "right",
                        borderBottom:
                          i === rows.length - 1
                            ? "none"
                            : "1px solid var(--line)",
                      }}
                    >
                      <Link
                        href={`/quizzes/${slug}/result/${r.id}`}
                        className="btn btn-sm btn-ghost"
                        style={{
                          textDecoration: "none",
                          fontSize: 12,
                        }}
                      >
                        View result
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 8,
            justifyContent: "center",
          }}
        >
          {canRetake ? (
            <Link href={`/quizzes/${slug}`} className="btn">
              Take quiz again
              {attemptsLeft !== null ? ` (${attemptsLeft} left)` : ""}
            </Link>
          ) : (
            <span className="btn" aria-disabled="true" style={{ opacity: 0.5, cursor: "default" }}>
              No attempts left
            </span>
          )}
          <Link href="/dashboard" className="btn btn-ghost">
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
