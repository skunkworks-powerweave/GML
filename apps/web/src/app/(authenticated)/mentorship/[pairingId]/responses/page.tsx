// /mentorship/[pairingId]/responses — the pairing's submitted feedback, read-only.
//
// Until this page existed nobody could read submitted mentorship feedback:
// not the mentor her mentee's answers, not an administrator anyone's. The
// quarter strip's "View responses" opened the live form instead, where each
// visit could file another copy. Behind the mentorship section gate via the
// layout; who reads which responses is lib/forms/responses.ts.
//
// The page's words are mentorship.responses.* in the translation bundles; the
// questions and answers are data, shown as they were stored.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom, assertCanAccessPairing } from "@/lib/authz";
import { pairingResponses } from "@/lib/forms/responses";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mentorship");
  return { title: t("responses.metaTitle") };
}

export default async function PairingResponsesPage({ params }: { params: Promise<{ pairingId: string }> }) {
  const { pairingId } = await params;
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const pairing = await assertCanAccessPairing(actor, pairingId);
  const t = await getTranslations("mentorship");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];

  const [mentor] = await db.select({ name: mentors.name }).from(mentors).where(eq(mentors.id, pairing.mentorId)).limit(1);
  const [teacher] = await db
    .select({ name: teachers.fullName })
    .from(teachers)
    .where(eq(teachers.id, pairing.teacherId))
    .limit(1);
  const responses = await pairingResponses(db, actor, pairingId, await getLocale());

  return (
    <div>
      <div className="page-header">
        <Link href={`/mentorship/${pairingId}`} className="btn btn-sm btn-ghost" style={{ marginBottom: 6, display: "inline-flex" }}>
          {t("responses.back")}
        </Link>
        <div className="label">{t("responses.eyebrow")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4, lineHeight: 1.2 }}>
          {mentor?.name ?? "—"} <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>↔</span> {teacher?.name ?? "—"}
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13 }}>
          {actor.role === "teacher" ? t("responses.introMentee") : t("responses.introOthers")}
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 14, maxWidth: 820 }}>
        {responses.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>{t("responses.empty")}</p>
        ) : (
          responses.map((r) => (
            <section key={r.id} className="card card-hi" style={{ padding: 16 }} data-testid="response">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{ fontFamily: "var(--serif)", fontSize: 17, margin: 0 }}>
                  {r.title ?? t("formTitle", { kind: r.kind, audience: r.audience })}
                </h2>
                <span className="chip">{t("responses.chip", { kind: r.kind, audience: r.audience })}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
                {r.byViewer ? t("responses.you") : (r.respondentName ?? t("responses.formerUser"))} ·{" "}
                <span className="mono">
                  {new Date(r.submittedAt).toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </div>
              {r.answers.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 10 }}>{t("responses.noAnswers")}</p>
              ) : (
                <dl style={{ margin: "12px 0 0", display: "grid", gap: 10 }}>
                  {r.answers.map((a) => (
                    <div key={a.name}>
                      <dt style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>{a.label}</dt>
                      <dd style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{a.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
