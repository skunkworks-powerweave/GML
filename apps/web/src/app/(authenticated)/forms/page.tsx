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

import type { Metadata } from "next";
import { and, asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@gml/db";
import { feedbackForms, feedbackResponses, mentorPairings, mentors, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import type { RoleName } from "@gml/shared/auth/roles";
import { formCatalogueLinks, UNLOCK_FORMS_HREF, type PairingChoice } from "@/lib/forms/catalogue-links";
import { actorFrom, mentorshipAccess } from "@/lib/visibility";
import { formTitle } from "@/lib/forms/quarterly";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Forms" };

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

/** The submit action's own errors, which it used to send to /inbox (which ignored them). */
const SUBMIT_ERRORS: Record<string, string> = {
  form_not_found: "That form is no longer available, so your answers were not saved. Choose a current form below.",
  invalid_form_submit: "That submission was incomplete and could not be saved. Please open the form again.",
};

export default async function FormsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
} = {}) {
  const sp = (await searchParams) ?? {};
  const submitError = sp.error ? (SUBMIT_ERRORS[sp.error] ?? null) : null;
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
      schema: feedbackForms.schema,
    })
    .from(feedbackForms)
    .where(and(eq(feedbackForms.active, true), inArray(feedbackForms.audience, audiences)))
    .orderBy(feedbackForms.audience, feedbackForms.kind, feedbackForms.version);

  // Which of these has this user already submitted, and for which pairing?
  // Answered forms stay listed rather than disappearing -- a teacher asking "did
  // I do that one?" needs to see it answered, not absent. Keyed per pairing
  // too, because a mentor answers the same form once for EACH mentee.
  const answered = new Set<string>();
  const answeredFor = new Set<string>();
  if (forms.length > 0) {
    const rows = await db
      .select({ formId: feedbackResponses.formId, pairingId: feedbackResponses.pairingId })
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
    for (const r of rows) {
      answered.add(r.formId);
      answeredFor.add(`${r.formId}:${r.pairingId}`);
    }
  }

  // A mentorship form is filled in against a PAIRING. Without one there is
  // nothing to answer about, so say that plainly instead of linking to a page
  // that will reject the submission.
  const isAdmin = role === "programme_admin" || role === "super_admin";

  // THE MENTORSHIP PASSWORD. This page lists a mentor's mentees by name, one
  // link per pairing, and each link opens what the mentor wrote about that
  // mentee -- the data /mentorship keeps behind its section password. It sat
  // outside that section and never asked, so a borrowed session read the
  // roster without the password. Locked: no pairing is looked up at all, not
  // even a count, and every row links to the password prompt. An administrator
  // previews bare forms and is party to no pairing, so has nothing to lock.
  const actor = actorFrom(session);
  const locked = !isAdmin && (!actor || !(await mentorshipAccess(db, actor)).granted);
  const { pairings, lookupFailed } = locked
    ? { pairings: [], lookupFailed: false }
    : await pairingsFor(session.user.id, role);
  const pairingCount = isAdmin || lookupFailed || locked ? null : pairings.length;

  return (
    <main style={{ padding: "24px 28px", maxWidth: 820 }}>
      <header style={{ marginBottom: 18 }}>
        <div className="label">Feedback</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>Forms</h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
          Feedback forms for the mentorship cycle. Answers save as you type.
        </p>
      </header>

      {submitError ? (
        <p
          role="alert"
          data-testid="forms-error"
          style={{
            background: "var(--rust-soft)",
            color: "var(--rust)",
            border: "1px solid var(--rust)",
            borderRadius: "var(--r-2, 8px)",
            padding: "12px 14px",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {submitError}
        </p>
      ) : null}

      {locked ? (
        <p
          role="status"
          data-testid="forms-locked"
          style={{
            border: "1px solid var(--line-2)",
            background: "var(--paper-2)",
            borderRadius: "var(--r-2, 8px)",
            padding: "12px 14px",
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        >
          Mentorship feedback is behind the mentorship password.{" "}
          <Link href={UNLOCK_FORMS_HREF}>Enter it</Link> to see who each form is for and to
          answer it.
        </p>
      ) : null}

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

      {pairingCount !== null && pairingCount > 1 ? (
        <p role="status" style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: 16 }}>
          You are in {pairingCount} mentorship pairings. Each form is answered for one of
          them &mdash; choose the name under the form. Every pairing is also listed at{" "}
          <Link href="/mentorship">Mentorship</Link>, with its forms for each quarter.
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
            // WHERE THIS ROW GOES: lib/forms/catalogue-links.ts. It used to be
            // one href -- the sole pairing's form, the bare form for an admin,
            // and "/inbox" for everyone else, which was every mentor with more
            // than one mentee. /inbox has no feedback-form card, so that was a
            // dead end. Now a row with several pairings lists one link per
            // pairing, named, and nobody is sent to /inbox.
            const links = formCatalogueLinks(slug, { isAdmin, pairings, lookupFailed, locked });
            // Per pairing when there are several: "Answered" as soon as ONE of
            // a mentor's five mentees was answered hid the other four.
            const perPairing = links.filter((l) => l.pairingId);
            const answeredHere = perPairing.filter((l) => answeredFor.has(`${f.id}:${l.pairingId}`)).length;
            // BY THE FORM'S OWN TITLE. Labelled by kind alone, the School visit
            // checklist (stored as kind 'baseline') and the mentor baseline were
            // two rows both called "Baseline for mentors".
            const title = (
              <span>
                <span style={{ fontWeight: 500, fontSize: 14 }}>
                  {formTitle(f.schema, f.kind, f.audience)}
                </span>
                <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
                  for {f.audience === "mentor" ? "mentors" : "mentees"}
                </span>
              </span>
            );
            const status = (
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
                {perPairing.length > 1
                  ? `${answeredHere} of ${perPairing.length} answered`
                  : done
                    ? "Answered"
                    : links.length === 0
                      ? "Needs a pairing"
                      : "Not started"}
              </span>
            );
            const card: React.CSSProperties = {
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
            };

            // One destination: the whole card is the link, as before.
            if (links.length === 1) {
              const only = links[0]!;
              return (
                <li key={f.id}>
                  <Link href={only.href} data-testid="form-link" style={card}>
                    <span>
                      {title}
                      {only.label && !isAdmin ? (
                        <span style={{ display: "block", fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
                          {only.label}
                        </span>
                      ) : null}
                    </span>
                    {status}
                  </Link>
                </li>
              );
            }

            // No pairing: nothing to link to (the banner above says why).
            if (links.length === 0) {
              return (
                <li key={f.id}>
                  <div style={card}>
                    {title}
                    {status}
                  </div>
                </li>
              );
            }

            // Several pairings: one named link each.
            return (
              <li key={f.id}>
                <div style={{ ...card, flexDirection: "column", alignItems: "stretch" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    {title}
                    {status}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {links.map((l) => {
                      const doneHere = l.pairingId ? answeredFor.has(`${f.id}:${l.pairingId}`) : false;
                      return (
                        <Link
                          key={l.href}
                          href={l.href}
                          data-testid="form-link"
                          className="btn btn-sm"
                          style={{ textDecoration: "none" }}
                        >
                          {l.label}
                          {doneHere ? " ✓" : ""}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

/**
 * The pairings this user belongs to, from whichever side, with the name of the
 * person on the other side -- the catalogue links one form per pairing, and a
 * link has to say whose form it is.
 *
 * submitFormAction REQUIRES a pairingId, so a catalogue link without one is a
 * form that cannot be submitted. This used to fetch LIMIT 2 ids just to tell
 * "exactly one" from "several", and send "several" -- every mentor with more
 * than one mentee -- to /inbox, which has no form card. Now it returns the
 * pairings themselves; lib/forms/catalogue-links.ts decides the links, and caps
 * how many a row renders.
 *
 * Bounded at 200: well past any real caseload, and the page renders at most
 * MAX_PAIRING_LINKS per row plus an "All N pairings" link.
 */
async function pairingsFor(
  userId: string,
  role: RoleName,
): Promise<{ pairings: PairingChoice[]; lookupFailed: boolean }> {
  // An administrator is party to no pairing; the links preview the bare form.
  if (role === "programme_admin" || role === "super_admin") {
    return { pairings: [], lookupFailed: false };
  }
  try {
    const rows =
      role === "mentor"
        ? await db
            .select({ id: mentorPairings.id, status: mentorPairings.status, label: teachers.fullName })
            .from(mentorPairings)
            .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
            .innerJoin(teachers, eq(teachers.id, mentorPairings.teacherId))
            .where(eq(mentors.userId, userId))
            .orderBy(asc(teachers.fullName))
            .limit(200)
        : await db
            .select({ id: mentorPairings.id, status: mentorPairings.status, label: mentors.name })
            .from(mentorPairings)
            .innerJoin(teachers, eq(teachers.id, mentorPairings.teacherId))
            .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
            .where(eq(teachers.userId, userId))
            .orderBy(asc(mentors.name))
            .limit(200);

    // Active pairings first: they are the ones a form is normally due for.
    const pairings = rows
      .map((r) => ({ id: r.id, label: r.label, active: r.status === "active" }))
      .sort((a, b) => Number(b.active) - Number(a.active));
    return { pairings, lookupFailed: false };
  } catch {
    // A failure here must not take the page down. The links then point at the
    // pairing list, which is a real choice, rather than at the inbox.
    return { pairings: [], lookupFailed: true };
  }
}
