// /repo/class/[id] — class detail: school + grade + stage + subjects taught at this grade
// + recent classroom sessions. PII-free (no learner names). The "View roster" link in the
// right column is conditionally rendered for super_admin / programme_admin only — clicking
// through to /learners is what triggers the SM-9 audit hook (see ./learners/page.tsx).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, schools, subjects, sessions, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import { uuidOrNotFound } from "@/lib/ids";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Class" };

// Stage chip kinds — map to the new `.chip` utility class variants in globals.css.
// The `bg` field is the underlying CSS var the chip-* class resolves to (kept here
// as documentation + so governance tests can assert the Primary→lichen / Middle→indigo
// / High→saffron mapping from a single source of truth).
const STAGE_CHIP: Record<string, { kind: string; bg: string }> = {
  Primary: { kind: "chip-lichen", bg: "var(--lichen-soft)" },
  Middle: { kind: "chip-indigo", bg: "var(--indigo-soft)" },
  High: { kind: "chip-saffron", bg: "var(--saffron-soft)" },
};

const STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  cancelled: { kind: "chip-rust", label: "Cancelled" },
};

export default async function RepoClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);
  const session = await auth();
  const role = session?.user?.role ?? "teacher";
  const canSeeRoster = role === "super_admin" || role === "programme_admin";

  const [cls] = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
  if (!cls) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, cls.schoolId)).limit(1);

  // Subjects whose [gradesMin..gradesMax] window covers this class's grade (NULLs treated as open-ended).
  const subjectRows = await db
    .select()
    .from(subjects)
    .where(
      and(
        eq(subjects.active, true),
        or(isNull(subjects.gradesMin), lte(subjects.gradesMin, cls.grade)),
        or(isNull(subjects.gradesMax), gte(subjects.gradesMax, cls.grade)),
      ),
    )
    .orderBy(subjects.displayOrder, subjects.name);

  // Recent classroom sessions for this class — LEFT JOIN subject + teacher for display.
  const sessionRows = await db
    .select({
      id: sessions.id,
      scheduledDate: sessions.scheduledDate,
      scheduledTime: sessions.scheduledTime,
      topic: sessions.topic,
      status: sessions.status,
      subjectName: subjects.name,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(sessions)
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .leftJoin(teachers, eq(sessions.teacherId, teachers.id))
    .where(eq(sessions.classId, id))
    .orderBy(desc(sessions.scheduledDate))
    .limit(12);

  const stage = STAGE_CHIP[cls.stage] ?? STAGE_CHIP.Primary;

  // Spec 137 — device-aware MobileDetailFrame adoption. Existing two-column
  // body becomes the mobile vertical stack inside the thin-header chrome.
  // The back arrow targets the parent school (matching the existing inline
  // ← link) so users keep their place in the repo tree.
  const device = await getDeviceType();
  const mobileBackHref = school ? `/repo/school/${school.id}` : "/repo";
  const mobileTitle = `Grade ${cls.grade}${school?.code ? ` · ${school.code}` : ""}`;

  const body = (
    <div>
      <div className="page-header">
        <Link
          href={school ? `/repo/school/${school.id}` : "/repo"}
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, display: "inline-flex" }}
        >
          ← {school?.code ?? "Repository"}
        </Link>
        <div>
          <div className="label">Class · {school?.code ?? "—"}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Grade {cls.grade}</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {cls.studentsCount} students across {cls.sectionsCount} section
            {cls.sectionsCount > 1 ? "s" : ""}
            {cls.classTeacherName ? `. Class teacher ${cls.classTeacherName}.` : "."}
          </p>
        </div>
      </div>

      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <section className="page-body grid grid-cols-1 items-start gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div style={{ display: "grid", gap: 16 }}>
          {/* Subjects taught at this grade */}
          <SectionCard title={`Subjects (${subjectRows.length})`} sub="Taught at this grade">
            {subjectRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                No subjects mapped to this grade yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Grades covered</th>
                    <th>Code</th>
                  </tr>
                </thead>
                <tbody>
                  {subjectRows.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>
                        {s.color ? (
                          <span
                            aria-hidden
                            style={{
                              display: "inline-block",
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              background: s.color,
                              marginRight: 8,
                              verticalAlign: "middle",
                            }}
                          />
                        ) : null}
                        {s.name}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {s.gradesMin ?? 1}–{s.gradesMax ?? 12}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {s.code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          {/* Sessions held in this class */}
          <SectionCard title={`Sessions held (${sessionRows.length})`} sub="Most recent first">
            {sessionRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                No classroom sessions logged yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Subject</th>
                    <th>Topic</th>
                    <th>Teacher</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => {
                    const pill = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {new Date(`${s.scheduledDate}T00:00:00`).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                          })}
                        </td>
                        <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                          {s.scheduledTime ? String(s.scheduledTime).slice(0, 5) : "—"}
                        </td>
                        <td>{s.subjectName ?? "—"}</td>
                        <td style={{ color: "var(--ink-2)" }}>{s.topic ?? "—"}</td>
                        <td>
                          {s.teacherName ?? "—"}
                          {s.teacherHindi ? (
                            <span
                              style={{
                                fontFamily: "var(--deva)",
                                color: "var(--ink-3)",
                                marginLeft: 8,
                                fontSize: 12,
                              }}
                            >
                              {s.teacherHindi}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span className={`chip ${pill.kind}`}>{pill.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </SectionCard>
        </div>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {/* Details KV */}
          <SectionCard title="Details">
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label="School">
                {school ? (
                  <Link
                    href={`/repo/school/${school.id}`}
                    style={{ color: "var(--indigo)", textDecoration: "none" }}
                  >
                    {school.code} · {school.name}
                  </Link>
                ) : (
                  "—"
                )}
              </KVRow>
              <KVRow label="Grade">{cls.grade}</KVRow>
              <KVRow label="Stage">
                <span className={`chip ${stage.kind}`}>{cls.stage}</span>
              </KVRow>
              <KVRow label="Students">{cls.studentsCount}</KVRow>
              <KVRow label="Sections">{cls.sectionsCount}</KVRow>
              <KVRow label="Class teacher">{cls.classTeacherName ?? "—"}</KVRow>
              <KVRow label="Status">
                <span className={`chip ${cls.active ? "chip-lichen" : ""}`}>
                  {cls.active ? "Active" : "Inactive"}
                </span>
              </KVRow>
            </div>
          </SectionCard>

          {/* PII-gated link to the learner roster — JSX prototype showed learners inline,
              but SM-9 (audit on view) requires moving the actual roster to /learners. */}
          {canSeeRoster ? (
            <Link
              href={`/repo/class/${id}/learners`}
              className="card card-hi"
              style={{
                padding: 16,
                textDecoration: "none",
                color: "var(--ink)",
                display: "block",
              }}
            >
              <div className="label">Roster · PII (audited)</div>
              <div style={{ fontWeight: 500, marginTop: 4, fontSize: 14 }}>
                View learners ({cls.studentsCount}) →
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                Opening this list is recorded in the audit log.
              </div>
            </Link>
          ) : (
            <div
              style={{
                background: "var(--paper-2)",
                border: "1px dashed var(--line)",
                borderRadius: "var(--r-3)",
                padding: 16,
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              Full learner roster restricted (PII). Programme admins only.
            </div>
          )}
        </div>
      </section>
    </div>
  );

  return device === "mobile" ? (
    <MobileDetailFrame title={mobileTitle} backHref={mobileBackHref}>
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}

function SectionCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {/* Scrolls sideways inside the card: a table wider than a phone was
          otherwise cut off by the card's overflow:hidden. */}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        // minmax(0, ...): a bare 1fr is at least as wide as its content, so a
        // long code or e-mail pushed the value past the card on a phone.
        gridTemplateColumns: "120px minmax(0, 1fr)",
        overflowWrap: "anywhere",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 500,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <div style={{ fontSize: 13, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}
