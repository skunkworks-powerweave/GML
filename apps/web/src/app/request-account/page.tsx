// /request-account — "Request an account", for someone who has no login yet.
// Linked from both login screens. PUBLIC: it sits outside (authenticated),
// and proxy.ts applies no policy to it, as to /login.
//
// A programme admin decides every request on /approvals: approving creates
// the login (and, for a teacher, her teacher record at the school she chose),
// rejecting records the reason. What the form records and how it answers:
// ./actions.ts.
//
// The school list is the active schools, by name: public knowledge, and what
// a teacher needs to say where she teaches.

import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { schools } from "@gml/db/schema";
import { LOCALE_COOKIE } from "@/i18n/config";
import { LanguageChoice } from "./language-choice";
import { RequestAccountForm } from "./request-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("login"))("requestAccount.title") };
}

export default async function RequestAccountPage() {
  const t = await getTranslations("login");
  const tBrand = await getTranslations("brand");
  const tLanguage = await getTranslations("language");
  const locale = await getLocale();
  const active = await db
    .select({ id: schools.id, name: schools.name })
    .from(schools)
    .where(eq(schools.active, true))
    .orderBy(asc(schools.name));

  return (
    <div style={{ minHeight: "100dvh", background: "var(--paper)", display: "flex", justifyContent: "center" }}>
      <main style={{ width: "100%", maxWidth: 480, padding: "16px 16px 48px", boxSizing: "border-box" }}>
        <LanguageChoice
          cookieName={LOCALE_COOKIE}
          label={tLanguage("pickerLabel")}
          options={[
            { code: "en", label: tLanguage("english"), current: locale === "en" },
            { code: "hi", label: tLanguage("hindi"), current: locale === "hi" },
            { code: "bo", label: tLanguage("bhoti"), current: locale === "bo" },
          ]}
        />
        <div className="label" style={{ marginTop: 24 }}>
          {tBrand("tagline")}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("requestAccount.title")}</h1>
        <p style={{ fontSize: 14, color: "var(--ink-3)", marginTop: 8, marginBottom: 24, lineHeight: 1.55 }}>
          {t("requestAccount.intro")}
        </p>
        <RequestAccountForm schools={active} />
        <p style={{ marginTop: 24, fontSize: 14 }}>
          <Link href="/login">{t("requestAccount.back")}</Link>
        </p>
      </main>
    </div>
  );
}
