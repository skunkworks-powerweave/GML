// /observation/new — nominate an observation cycle.
//
// The first surface in the product that CREATES a cycle; see ./actions.ts for
// why it exists. Administrators only: nominating is a programme decision, and
// the grid entity it shares its validation with is administrator-only too.
//
// Plain server-rendered form, no client JavaScript: the pickers are <select>s
// filled here, so it works on the same slow links the rest of the app targets.

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, asc, eq, isNull, like } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, schools, subjects, teachers, users } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { lookupOwn } from "@/lib/lookup";
import { cycleCodePrefix, nextCycleCode } from "@/lib/observation/cycle-code";
import { nominateCycleAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("observation");
  return { title: t("nominate.metaTitle") };
}

const field: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2, 8px)",
  background: "var(--card-hi)",
  fontSize: 13,
  width: "100%",
};

const labelText: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ink-2)",
};

// The ?error= codes ./actions.ts redirects with, and the fields it can name;
// the words are nominate.errors.<code> and nominate.fields.<field>. Own keys
// only (lib/lookup.ts): ?error=__proto__ must read as no error at all.
const ERRORS: Record<string, true> = { invalid: true, observer: true, duplicate: true, failed: true };

const FIELD_NAMES: Record<string, true> = {
  teacherId: true,
  observerId: true,
  kind: true,
  scheduledAt: true,
  subjectId: true,
  topic: true,
  code: true,
};

export default async function NominateCyclePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; field?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  const sp = await searchParams;
  const t = await getTranslations("observation");

  const year = new Date().getUTCFullYear();
  const [teacherRows, observerRows, subjectRows, codeRows] = await Promise.all([
    db
      .select({ id: teachers.id, name: teachers.fullName, school: schools.name })
      .from(teachers)
      .leftJoin(schools, eq(schools.id, teachers.schoolId))
      .where(eq(teachers.active, true))
      .orderBy(asc(teachers.fullName))
      .limit(2000),
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "observer"), eq(users.active, true), isNull(users.deletedAt)))
      .orderBy(asc(users.name))
      .limit(500),
    db
      .select({ id: subjects.id, name: subjects.name })
      .from(subjects)
      .where(eq(subjects.active, true))
      .orderBy(asc(subjects.displayOrder), asc(subjects.name)),
    db
      .select({ code: observationCycles.code })
      .from(observationCycles)
      .where(like(observationCycles.code, `${cycleCodePrefix(year)}%`)),
  ]);
  const nextCode = nextCycleCode(
    year,
    codeRows.map((r) => r.code),
  );

  const errorCode = lookupOwn(ERRORS, sp.error) ? (sp.error as string) : null;
  const badField = lookupOwn(FIELD_NAMES, sp.field) ? (sp.field as string) : null;
  const error = errorCode
    ? errorCode === "invalid" && badField
      ? t("nominate.errors.invalidField", { field: t(`nominate.fields.${badField}`) })
      : t(`nominate.errors.${errorCode}`)
    : null;
  const missing =
    teacherRows.length === 0
      ? { what: "teachers" as const, href: "/admin/data/teachers" }
      : observerRows.length === 0
        ? { what: "observers" as const, href: "/admin/users" }
        : null;
  const missingLink = (chunks: React.ReactNode) => <Link href={missing?.href ?? "/admin"}>{chunks}</Link>;

  return (
    <div>
      <div className="page-header">
        <Link href="/observation" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          {t("allCycles")}
        </Link>
        <div className="label" style={{ marginTop: 8 }}>
          {t("sectionLabel")}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("nominate.title")}</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 6, maxWidth: 640, lineHeight: 1.5 }}>
          {t.rich("nominate.intro", { b: (chunks) => <b>{chunks}</b> })}
        </p>
      </div>

      <div className="page-body" style={{ maxWidth: 720 }}>
        {error ? (
          <div
            role="alert"
            style={{
              background: "var(--rust-soft)",
              color: "var(--rust)",
              border: "1px solid var(--rust)",
              borderRadius: "var(--r-2)",
              padding: 12,
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        ) : null}

        {missing ? (
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
            {missing.what === "teachers"
              ? t.rich("nominate.missingTeachers", { link: missingLink })
              : t.rich("nominate.missingObservers", { link: missingLink })}
          </p>
        ) : null}

        <form action={nominateCycleAction} className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {t.rich("nominate.code", { code: nextCode, mono: (chunks) => <span className="mono">{chunks}</span> })}
          </div>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelText}>{t("nominate.teacher")}</span>
            <select name="teacherId" required defaultValue="" style={field}>
              <option value="" disabled>
                {t("nominate.chooseTeacher")}
              </option>
              {teacherRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.school ? ` — ${row.school}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelText}>{t("nominate.observer")}</span>
            <select name="observerId" required defaultValue="" style={field}>
              <option value="" disabled>
                {t("nominate.chooseObserver")}
              </option>
              {observerRows.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name ?? o.email}
                  {o.name ? ` (${o.email})` : ""}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelText}>{t("nominate.kind")}</span>
              <select name="kind" required defaultValue="" style={field}>
                <option value="" disabled>
                  {t("nominate.choose")}
                </option>
                <option value="baseline">{t("kind.baseline")}</option>
                <option value="developmental">{t("kind.developmental")}</option>
                <option value="evaluative">{t("kind.evaluative")}</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelText}>{t("nominate.date")}</span>
              <input name="scheduledAt" type="date" required style={field} />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelText}>{t("nominate.subject")}</span>
              <select name="subjectId" defaultValue="" style={field}>
                <option value="">—</option>
                {subjectRows.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelText}>{t("nominate.topic")}</span>
              <input name="topic" type="text" maxLength={240} style={field} />
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="submit" className="btn btn-primary" disabled={missing !== null}>
              {t("nominate.submit")}
            </button>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {t.rich("nominate.csv", {
                link: (chunks) => <Link href="/admin/data/observation-cycles">{chunks}</Link>,
              })}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
