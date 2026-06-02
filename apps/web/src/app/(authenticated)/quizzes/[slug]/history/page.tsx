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
};

export default async function QuizHistoryPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { slug } = await params;

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

  return (
    <main>
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
            <Link
              href={`/quizzes/${slug}`}
              className="btn btn-primary"
              style={{ marginTop: 16, textDecoration: "none" }}
            >
              Start the quiz
            </Link>
          </div>
        ) : (
          <div
            data-testid="quiz-history-table"
            className="card card-hi"
            style={{ padding: 0, overflow: "hidden" }}
          >
            <div
              role="table"
              aria-label="Your quiz attempts"
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(0, 1.5fr) minmax(0, 0.6fr) minmax(0, 0.6fr) minmax(0, 0.6fr)",
                rowGap: 0,
              }}
            >
              <div
                role="row"
                style={{
                  display: "contents",
                  // Header row.
                }}
              >
                {["Submitted", "Score", "Result", ""].map((label, i) => (
                  <div
                    key={i}
                    role="columnheader"
                    style={{
                      padding: "10px 14px",
                      fontSize: 11,
                      fontFamily: "var(--mono)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--ink-3)",
                      borderBottom: "1px solid var(--line)",
                      background: "var(--paper-2)",
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>
              {rows.map((r, i) => (
                <div
                  key={r.id}
                  role="row"
                  data-testid="quiz-history-row"
                  style={{ display: "contents" }}
                >
                  <div
                    role="cell"
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
                    {formatSubmittedAt(r.submittedAt)}
                  </div>
                  <div
                    role="cell"
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
                  </div>
                  <div
                    role="cell"
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
                  </div>
                  <div
                    role="cell"
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
                  </div>
                </div>
              ))}
            </div>
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
          <Link href={`/quizzes/${slug}`} className="btn">
            Take quiz again
          </Link>
          <Link href="/dashboard" className="btn btn-ghost">
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
