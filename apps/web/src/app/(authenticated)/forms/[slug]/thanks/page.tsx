// /forms/[slug]/thanks — post-submit confirmation. Spec 074 (Phase 8).
//
// Tiny server-rendered card that re-resolves the form by slug so we can echo
// the title back at the respondent. No state of its own. The submit action
// passes ?pairingId= so the card can link back to the pairing and to its
// read-only record of submitted feedback.
//
// Both buttons used to go to /inbox -- which has no forms on it -- and the
// text promised "The mentor/mentee on the other side of this pairing will see
// a summary in their inbox". Nothing ever wrote that notification.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { feedbackForms } from "@gml/db/schema";
import { auth } from "@/auth";
import { decodeFormSlug } from "@/lib/forms/catalogue-links";
import { formTitle } from "@/lib/forms/quarterly";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";

type FeedbackKind = "baseline" | "progress_1" | "progress_2" | "final";
type FeedbackAudience = "mentor" | "mentee";

const KINDS: readonly FeedbackKind[] = ["baseline", "progress_1", "progress_2", "final"] as const;
const AUDIENCES: readonly FeedbackAudience[] = ["mentor", "mentee"] as const;

function parseSlug(
  slug: string,
): { kind: FeedbackKind; audience: FeedbackAudience; version: string } | null {
  const firstDash = slug.indexOf("-");
  if (firstDash < 0) return null;
  const kindRaw = slug.slice(0, firstDash);
  const rest = slug.slice(firstDash + 1);
  const secondDash = rest.indexOf("-");
  if (secondDash < 0) return null;
  const audienceRaw = rest.slice(0, secondDash);
  const versionRaw = rest.slice(secondDash + 1);
  if (!KINDS.includes(kindRaw as FeedbackKind)) return null;
  if (!AUDIENCES.includes(audienceRaw as FeedbackAudience)) return null;
  if (versionRaw.length === 0) return null;
  return {
    kind: kindRaw as FeedbackKind,
    audience: audienceRaw as FeedbackAudience,
    version: versionRaw,
  };
}

export default async function FormThanksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ pairingId?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const slug = decodeFormSlug((await params).slug);
  const parsed = parseSlug(slug);
  // Only ever used to build links; the pairing page checks access itself.
  const rawPairing = ((await searchParams) ?? {}).pairingId;
  const pairingId = typeof rawPairing === "string" && isUuid(rawPairing) ? rawPairing : null;

  // "Your response to Submitted has been recorded" was what a form with no
  // schema title (all four mentor forms) produced.
  let title = "this form";
  let hindiTitle: string | undefined;
  if (parsed) {
    const [form] = await db
      .select()
      .from(feedbackForms)
      .where(
        and(
          eq(feedbackForms.kind, parsed.kind),
          eq(feedbackForms.audience, parsed.audience),
          eq(feedbackForms.version, parsed.version),
        ),
      )
      .limit(1);
    if (form) {
      const raw = form.schema as { title?: string; hindiTitle?: string } | null;
      title = formTitle(raw, form.kind, form.audience);
      if (raw && typeof raw === "object") hindiTitle = raw.hindiTitle;
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: "60px auto", textAlign: "center" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "var(--lichen-soft)",
          color: "var(--lichen)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 28,
          marginBottom: 14,
        }}
        aria-hidden
      >
        ✓
      </div>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-3)",
        }}
      >
        Response saved
      </div>
      <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 6, lineHeight: 1.2 }}>
        Thank you.
        {hindiTitle ? (
          <span
            style={{
              fontFamily: "var(--deva)",
              color: "var(--ink-3)",
              marginLeft: 10,
              fontSize: 20,
              display: "block",
              marginTop: 4,
            }}
          >
            {hindiTitle}
          </span>
        ) : null}
      </h1>
      <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
        Your response to <strong>{title}</strong> has been recorded.
        {pairingId ? (
          <>
            {" "}You can read it again on the pairing&apos;s{" "}
            <Link href={`/mentorship/${pairingId}/responses`} style={{ color: "var(--indigo)" }}>
              submitted feedback
            </Link>{" "}
            page.
          </>
        ) : null}
      </p>

      <div
        style={{
          marginTop: 26,
          display: "flex",
          gap: 12,
          justifyContent: "center",
        }}
      >
        <Link
          href={pairingId ? `/mentorship/${pairingId}` : "/mentorship"}
          style={{
            background: "var(--ink)",
            color: "var(--paper)",
            padding: "10px 18px",
            borderRadius: "var(--r-2)",
            fontSize: 13,
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          {pairingId ? "Back to pairing" : "Back to mentorship"}
        </Link>
        <Link
          // /inbox has no forms on it; a mentor working through five mentees
          // was left to find /forms on their own.
          href="/forms"
          style={{
            background: "transparent",
            color: "var(--ink-2)",
            padding: "10px 18px",
            borderRadius: "var(--r-2)",
            fontSize: 13,
            border: "1px solid var(--line)",
            textDecoration: "none",
          }}
        >
          Open another form
        </Link>
      </div>
    </div>
  );
}
