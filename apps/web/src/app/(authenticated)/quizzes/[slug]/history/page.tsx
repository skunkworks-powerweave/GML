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

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { quizzes, quizSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";
import { lookupOwn } from "@/lib/lookup";
import { quizShownTo } from "../quiz-scope";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("history.metaTitle") };
}

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
  const t = await getTranslations("rtt");
  // ?error= code -> its message under rtt.history.errors. time_up: the runner
  // page sends a learner here when they come back to a timed attempt with no
  // time left but inside the submit grace -- answers already sent may still
  // arrive and be scored, so the attempt is not closed yet.
  const HISTORY_ERRORS: Record<string, string> = {
    attempts_exhausted: "attemptsExhausted",
    time_expired: "timeExpired",
    time_up: "timeUp",
    attempt_closed: "attemptClosed",
  };
  const errorKey = sp.error ? lookupOwn(HISTORY_ERRORS, sp.error) : undefined;
  const historyError = errorKey ? t(`history.errors.${errorKey}`) : null;

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
  // A quiz switched off, or on an RTT subject this learner is not shown (a
  // retired one, one taught elsewhere: W3-21), cannot be started from here:
  // the runner answers it with a 404. Her own past results stay readable.
  const open =
    quiz.active && (await quizShownTo(db, { id: userId, role: session.user.role }, quiz));
  const canRetake = open && (attemptsLeft === null || attemptsLeft > 0);

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
          {t("quiz.backQuiz")}
        </Link>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
          {t("history.title")}
        </h1>
        <p
          style={{
            color: "var(--ink-3)",
            marginTop: 4,
            fontSize: 13,
          }}
        >
          {t("history.subtitle", { title: quiz.title, threshold: quiz.passThreshold })}
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
              {t("history.emptyTitle")}
            </h2>
            <p style={{ color: "var(--ink-3)", marginTop: 8, fontSize: 13 }}>
              {t("history.emptyBody")}
            </p>
            {canRetake ? (
              <Link
                href={`/quizzes/${slug}`}
                className="btn btn-primary"
                style={{ marginTop: 16, textDecoration: "none" }}
              >
                {t("history.startQuiz")}
              </Link>
            ) : (
              <p style={{ marginTop: 16, fontSize: 13, color: "var(--ink-3)" }}>
                {open ? t("history.noAttemptsLeftBody") : t("history.notOpenBody")}
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
          // That date is the row's one link for a keyboard and a screen reader,
          // named for what it opens; "View result" beside it goes to the same
          // place and is for a pointer only (out of the tab order and hidden),
          // or every attempt would be two tab stops, one named by a timestamp.
          <div
            data-testid="quiz-history-table"
            className="card card-hi"
            style={{ padding: 0, overflowX: "auto" }}
          >
            <table className="t" aria-label={t("history.tableLabel")}>
              <thead>
                <tr>
                  <th>{t("history.col.submitted")}</th>
                  <th>{t("history.col.score")}</th>
                  <th>{t("history.col.result")}</th>
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
                      <Link
                        href={`/quizzes/${slug}/result/${r.id}`}
                        aria-label={t("history.attemptLabel", { date: formatSubmittedAt(r.submittedAt) })}
                        style={{ color: "inherit" }}
                      >
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
                        {r.passed ? t("history.pass") : t("history.retry")}
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
                        aria-hidden="true"
                        tabIndex={-1}
                        className="btn btn-sm btn-ghost"
                        style={{
                          textDecoration: "none",
                          fontSize: 12,
                        }}
                      >
                        {t("history.viewResult")}
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
              {attemptsLeft !== null ? t("history.takeAgainLeft", { left: attemptsLeft }) : t("history.takeAgain")}
            </Link>
          ) : (
            <span className="btn" aria-disabled="true" style={{ opacity: 0.5, cursor: "default" }}>
              {open ? t("history.noAttemptsLeft") : t("history.notOpen")}
            </span>
          )}
          <Link href="/dashboard" className="btn btn-ghost">
            {t("history.backToDashboard")}
          </Link>
        </div>
      </div>
    </main>
  );
}
