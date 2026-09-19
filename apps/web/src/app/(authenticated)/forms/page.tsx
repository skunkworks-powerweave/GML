// /forms — the feedback forms available to this user.
//
// This route did not exist. `apps/web/src/app/(authenticated)/forms/` contained
// only `[slug]/`, while config/nav.ts linked mentors and teachers here and
// lib/chrome-counts.ts computed a `pendingForms` badge for the link. So two of
// the five roles had a sidebar item that 404'd, carrying a number next to it.
//
// The list is scoped by AUDIENCE, which is also the fix for a real gap: the
// individual form page enforces audience on GET, but the catalogue never
// existed to be enforced, and a mentee had no way to discover which forms were
// theirs other than by guessing slugs.

import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@gml/db";
import { feedbackForms, feedbackResponses, mentorPairings, mentors, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import type { RoleName } from "@gml/shared/auth/roles";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  baseline: "Baseline",
  progress_1: "Progress check 1",
  progress_2: "Progress check 2",
  final: "Final reflection",
};

/**
 * Which audiences may this role fill in?
 *
 * Mirrors the check the individual form page applies on GET. Keeping the two in
 * step matters: a catalogue that lists forms the detail page will refuse is a
 * worse experience than no catalogue, because the user cannot tell a permission
 * problem from a broken link.
 */
function audiencesFor(role: RoleName): ("mentor" | "mentee")[] {
  switch (role) {
    case "mentor":
      return ["mentor"];
    case "teacher":
      return ["mentee"];
    case "observer":
      // Observers do not take part in the mentorship feedback cycle.
      return [];
    case "programme_admin":
    case "super_admin":
      // Administrators can see both so they can preview what staff will get.
      return ["mentor", "mentee"];
    default:
      return [];
  }
}

export default async function FormsIndexPage() {
  const session = await auth();
  if (!session) redirect("/login?next=%2Fforms");

  const role = session.user.role;
  const audiences = audiencesFor(role);

  if (audiences.length === 0) {
    return (
      <main style={{ padding: "24px 28px", maxWidth: 820 }}>
        <div className="label">Feedback</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>Forms</h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 10, lineHeight: 1.6 }}>
          There are no feedback forms for your role. The mentorship feedback cycle is
          completed by mentors and their mentees.
        </p>
      </main>
    );
  }

  const forms = await db
    .select({
      id: feedbackForms.id,
      kind: feedbackForms.kind,
      audience: feedbackForms.audience,
      version: feedbackForms.version,
    })
    .from(feedbackForms)
    .where(and(eq(feedbackForms.active, true), inArray(feedbackForms.audience, audiences)))
    .orderBy(feedbackForms.audience, feedbackForms.kind);

  // Which of these has this user already submitted? Answered forms stay listed
  // rather than disappearing -- a teacher asking "did I do that one?" needs to
  // see it answered, not absent.
  const answered = new Set<string>();
  if (forms.length > 0) {
    const rows = await db
      .select({ formId: feedbackResponses.formId })
      .from(feedbackResponses)
      .where(
        and(
          eq(feedbackResponses.respondentUserId, session.user.id),
          inArray(
            feedbackResponses.formId,
            forms.map((f) => f.id),
          ),
        ),
      );
    for (const r of rows) answered.add(r.formId);
  }

  // A mentorship form is filled in against a PAIRING. Without one there is
  // nothing to answer about, so say that plainly instead of linking to a page
  // that will reject the submission.
  const pairingCount = await countPairingsFor(session.user.id, role);

  return (
    <main style={{ padding: "24px 28px", maxWidth: 820 }}>
      <header style={{ marginBottom: 18 }}>
        <div className="label">Feedback</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>Forms</h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
          Feedback forms for the mentorship cycle. Answers save as you type.
        </p>
      </header>

      {pairingCount === 0 ? (
        <p
          role="status"
          style={{
            border: "1px solid var(--saffron)",
            background: "var(--saffron-soft)",
            borderRadius: "var(--r-2, 8px)",
            padding: "12px 14px",
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        >
          You are not currently part of a mentorship pairing, so these forms cannot be
          submitted yet. They will become available once your programme administrator
          pairs you.
        </p>
      ) : null}

      {forms.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          No forms have been published yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {forms.map((f) => {
            const slug = `${f.kind}-${f.audience}-${f.version}`;
            const done = answered.has(f.id);
            return (
              <li key={f.id}>
                <Link
                  href={`/forms/${slug}`}
                  data-testid="form-link"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2, 8px)",
                    padding: "12px 14px",
                    background: "var(--card)",
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <span>
                    <span style={{ fontWeight: 500, fontSize: 14 }}>
                      {KIND_LABELS[f.kind] ?? f.kind}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
                      for {f.audience === "mentor" ? "mentors" : "mentees"}
                    </span>
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--line-2)",
                      color: done ? "var(--ok-ink, #047857)" : "var(--ink-3)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {done ? "Answered" : "Not started"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

/** How many live pairings this user belongs to, from whichever side. */
async function countPairingsFor(userId: string, role: RoleName): Promise<number> {
  try {
    // Administrators always see the forms; the hint is for staff who cannot
    // submit yet, and an admin previewing the catalogue is not in that position.
    if (role === "programme_admin" || role === "super_admin") return 1;

    if (role === "mentor") {
      const rows = await db
        .select({ id: mentorPairings.id })
        .from(mentorPairings)
        .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
        .where(eq(mentors.userId, userId))
        .limit(1);
      return rows.length;
    }

    const rows = await db
      .select({ id: mentorPairings.id })
      .from(mentorPairings)
      .innerJoin(teachers, eq(teachers.id, mentorPairings.teacherId))
      .where(eq(teachers.userId, userId))
      .limit(1);
    return rows.length;
  } catch {
    // A failure here must not take the page down -- it only controls a hint,
    // and showing the forms is the safer wrong answer.
    return 1;
  }
}
