// /observation/new — nominate an observation cycle.
//
// The first surface in the product that CREATES a cycle; see ./actions.ts for
// why it exists. Administrators only: nominating is a programme decision, and
// the grid entity it shares its validation with is administrator-only too.
//
// Plain server-rendered form, no client JavaScript: the pickers are <select>s
// filled here, so it works on the same slow links the rest of the app targets.

import Link from "next/link";
import { and, asc, eq, isNull, like } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, schools, subjects, teachers, users } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { cycleCodePrefix, nextCycleCode } from "@/lib/observation/cycle-code";
import { nominateCycleAction } from "./actions";

export const dynamic = "force-dynamic";

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

const ERRORS: Record<string, string> = {
  invalid: "Some of the details are missing or not valid.",
  observer: "That observer account is not an active observer. Pick one from the list.",
  duplicate: "Another cycle took that code at the same moment. Please submit again.",
  failed: "The cycle could not be saved. Please try again.",
};

const FIELD_NAMES: Record<string, string> = {
  teacherId: "Teacher",
  observerId: "Observer",
  kind: "Kind",
  scheduledAt: "Date",
  subjectId: "Subject",
  topic: "Topic",
  code: "Code",
};

export default async function NominateCyclePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; field?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  const sp = await searchParams;

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

  const error = sp.error && ERRORS[sp.error] ? ERRORS[sp.error] : null;
  const badField = sp.field && FIELD_NAMES[sp.field] ? FIELD_NAMES[sp.field] : null;
  const missing =
    teacherRows.length === 0
      ? { what: "teachers", href: "/admin/data/teachers", label: "Admin → Teachers" }
      : observerRows.length === 0
        ? { what: "observer accounts", href: "/admin/users", label: "Admin → Users (role: Observer)" }
        : null;

  return (
    <div>
      <div className="page-header">
        <Link href="/observation" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          ← All cycles
        </Link>
        <div className="label" style={{ marginTop: 8 }}>
          Classroom observation
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Nominate a cycle</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 6, maxWidth: 640, lineHeight: 1.5 }}>
          The cycle starts at <b>Nominated</b>; the teacher&rsquo;s pre-form moves it on. It is
          visible to the observer you choose, the teacher, and the teacher&rsquo;s mentor.
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
            {sp.error === "invalid" && badField ? ` Check: ${badField}.` : null}
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
            There are no active {missing.what} yet, so a cycle cannot be nominated. Add them at{" "}
            <Link href={missing.href}>{missing.label}</Link> first.
          </p>
        ) : null}

        <form action={nominateCycleAction} className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Code: <span className="mono">{nextCode}</span> (assigned when you save)
          </div>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelText}>Teacher being observed</span>
            <select name="teacherId" required defaultValue="" style={field}>
              <option value="" disabled>
                Choose a teacher…
              </option>
              {teacherRows.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.school ? ` — ${t.school}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelText}>Observer</span>
            <select name="observerId" required defaultValue="" style={field}>
              <option value="" disabled>
                Choose an observer…
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
              <span style={labelText}>Kind</span>
              <select name="kind" required defaultValue="" style={field}>
                <option value="" disabled>
                  Choose…
                </option>
                <option value="baseline">Baseline</option>
                <option value="developmental">Developmental</option>
                <option value="evaluative">Evaluative</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelText}>Date</span>
              <input name="scheduledAt" type="date" required style={field} />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelText}>Subject (optional)</span>
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
              <span style={labelText}>Topic (optional)</span>
              <input name="topic" type="text" maxLength={240} style={field} />
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="submit" className="btn btn-primary" disabled={missing !== null}>
              Nominate cycle
            </button>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              Loading many at once? Use CSV import at{" "}
              <Link href="/admin/data/observation-cycles">Admin → Observation Cycles</Link>.
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
