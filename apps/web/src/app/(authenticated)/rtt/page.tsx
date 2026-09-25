// /rtt — phase index + subjects matrix.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@gml/db";
import { phases, terms, rttSubjects } from "@gml/db/schema";
import { auth } from "@/auth";
import { listOpenAssessments } from "@/lib/rtt/assessments";
import { placeLabel, placeOptions, rttScope } from "@/lib/rtt/scope";
import { PlacePicker } from "./place-picker";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "RTT phases & subjects" };

// Who /rtt/teach-back lets in: its READ_ROLES, repeated here because that page
// does not export them. tests/behaviour/rtt-teach-back-link.test.ts asks the
// queue page itself, so the two cannot drift apart unnoticed.
const TEACH_BACK_REVIEWERS: ReadonlySet<string> = new Set(["super_admin", "programme_admin", "mentor", "observer"]);

const SUBJECT_PALETTE = [
  { chip: "chip-indigo", stripe: "var(--indigo)" },
  { chip: "chip-saffron", stripe: "var(--saffron)" },
  { chip: "chip-lichen", stripe: "var(--lichen)" },
  { chip: "chip-rust", stripe: "var(--rust)" },
  { chip: "chip-ink", stripe: "var(--ink-2)" },
  { chip: "chip-indigo", stripe: "oklch(0.40 0.10 320)" },
] as const;

export default async function RttIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ district?: string; zone?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const viewer = { id: session.user.id, role: session.user.role };

  const phaseRows = await db.select().from(phases).orderBy(phases.sequence);
  const termRows = await db.select().from(terms);
  // Only the subjects this viewer is shown (lib/rtt/scope.ts): active ones
  // (every row was listed, so retiring a subject changed nothing here), and
  // for a teacher those taught in her own district and zone -- everyone was
  // shown the whole programme. Staff choose a district or zone below.
  const scope = await rttScope(db, viewer, await searchParams);
  const subjectRows = await db.select().from(rttSubjects).where(scope.subjectWhere);
  const placeChoices = scope.isStaff ? await placeOptions(db) : [];
  // Said from the data. This read "across Leh + Kargil" whatever the rows were.
  const where = scope.place
    ? scope.isStaff
      ? `in ${placeLabel(scope.place)}`
      : `for ${placeLabel(scope.place)}`
    : scope.isStaff && placeChoices.length > 0
      ? `across ${placeChoices.map((d) => d.districtName).join(" + ")}`
      : "taught across the programme";
  // The dashboard's "N open quizzes" to-do links here and counts exactly this
  // list (lib/rtt/assessments.ts). /rtt used to list no quizzes at all, so the
  // to-do led nowhere. A learner's list: to staff it would be every quiz in
  // the programme, under "you have not taken yet".
  const openAssessments = scope.isStaff ? [] : await listOpenAssessments(db, viewer);

  return (
    <div>
      <div className="page-header">
        <div className="label">RTT — Recruit, Train, Transform</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>RTT phases &amp; subjects</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {phaseRows.length} phases · {termRows.length} terms · {subjectRows.length} subjects {where}.
        </p>
        {scope.isStaff ? <PlacePicker basePath="/rtt" options={placeChoices} place={scope.place} /> : null}

        {/* THE ONLY WAY INTO THE ONLINE SURFACES.
            /rtt/online/synchronous (the webinar and live-quiz calendar) and
            /rtt/online/asynchronous both shipped complete and were linked from
            nowhere -- not from this hub, not from nav.ts, not from any other
            page. Two finished features reachable only by someone who already
            knew the URL, which in practice means nobody. /rtt is where they
            belong: it is the section root for everything RTT. */}
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Link href="/rtt/online/synchronous" className="btn btn-sm">
            Webinars &amp; live quizzes →
          </Link>
          <Link href="/rtt/online/asynchronous" className="btn btn-sm btn-ghost">
            Self-paced units →
          </Link>
          <Link href="/rtt/progress" className="btn btn-sm btn-ghost">
            {viewer.role === "programme_admin" || viewer.role === "super_admin" || viewer.role === "mentor"
              ? "Progress & results →"
              : "My progress →"}
          </Link>
          {/* Only for the roles the queue admits (its READ_ROLES): shown to
              everyone, it sent teachers -- this hub's main audience -- to
              /forbidden. */}
          {TEACH_BACK_REVIEWERS.has(viewer.role) ? (
            <Link href="/rtt/teach-back" className="btn btn-sm btn-ghost">
              Teach-back queue →
            </Link>
          ) : null}
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {openAssessments.length > 0 ? (
          <section className="card card-hi" aria-labelledby="open-assessments">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div id="open-assessments" style={{ fontWeight: 600, fontSize: 13 }}>
                Open assessments ({openAssessments.length})
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                Published quizzes you have not taken yet.
              </div>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: "0 14px", fontSize: 13 }}>
              {openAssessments.map((q, i) => (
                <li
                  key={q.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 0",
                    borderTop: i ? "1px solid var(--line)" : "none",
                  }}
                >
                  <div>
                    <div>{q.title}</div>
                    <Link href={`/rtt/subject/${q.subjectId}`} style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {q.subjectName}
                    </Link>
                  </div>
                  <Link href={`/quizzes/${q.slug}`} className="btn btn-sm btn-primary" style={{ textDecoration: "none" }}>
                    Start
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {phaseRows.length === 0 ? (
          <p style={{ color: "var(--ink-3)" }}>No phases seeded yet. Run the spec 086 seed script.</p>
        ) : (
          <>
            {/* Phase strip */}
            <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
              {phaseRows.map((p) => {
                const phaseTerms = termRows.filter((t) => t.phaseId === p.id).sort((a, b) => a.sequence - b.sequence);
                const phaseSubjectCount = subjectRows.filter((s) =>
                  phaseTerms.some((t) => t.id === s.termId),
                ).length;
                return (
                  <article key={p.id} className="card" style={{ padding: 18 }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      PHASE {p.sequence} / {phaseRows.length}
                      {/* teachers.current_phase_id existed and nothing read it. */}
                      {p.id === scope.currentPhaseId ? (
                        <span className="chip chip-saffron" style={{ marginLeft: 8 }}>
                          Your phase
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontFamily: "var(--serif)", fontSize: 22, marginTop: 6, letterSpacing: "-0.01em" }}>
                      {p.label}
                    </div>
                    {p.startDate ? (
                      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
                        {new Date(p.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                        {p.endDate ? ` → ${new Date(p.endDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                      </div>
                    ) : null}
                    <div className="mono" style={{ marginTop: 14, display: "flex", gap: 18, fontSize: 11, color: "var(--ink-3)" }}>
                      <span>{phaseSubjectCount} subjects</span>
                      <span>{phaseTerms.length} terms</span>
                    </div>
                  </article>
                );
              })}
            </section>

            {/* Subjects grid (grouped by phase + term) */}
            {phaseRows.map((p) => {
              const phaseTerms = termRows.filter((t) => t.phaseId === p.id).sort((a, b) => a.sequence - b.sequence);
              if (phaseTerms.length === 0) return null;
              return (
                <section key={`phase-${p.id}`} style={{ display: "grid", gap: 12 }}>
                  <div className="label">{p.label}</div>
                  {phaseTerms.map((t) => {
                    const termSubjects = subjectRows.filter((s) => s.termId === t.id);
                    return (
                      <div key={t.id} style={{ display: "grid", gap: 10 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span className="chip chip-indigo">{t.name}</span>
                          {termSubjects.length === 0 ? (
                            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>no subjects yet</span>
                          ) : null}
                        </div>
                        {termSubjects.length > 0 ? (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
                            {termSubjects.map((s, idx) => {
                              const palette = SUBJECT_PALETTE[idx % SUBJECT_PALETTE.length];
                              return (
                                <Link
                                  key={s.id}
                                  href={`/rtt/subject/${s.id}`}
                                  className="card card-hi"
                                  style={{ padding: 0, overflow: "hidden", textDecoration: "none", color: "inherit", display: "block" }}
                                >
                                  <div style={{ height: 8, background: palette.stripe }} />
                                  <div style={{ padding: 16 }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                                        {s.code ?? `${p.label}/${t.name}`}
                                      </span>
                                      {s.active ? (
                                        <span className={`chip ${palette.chip}`}>EN</span>
                                      ) : (
                                        // Only an administrator is shown one.
                                        <span className="chip chip-rust">Inactive</span>
                                      )}
                                    </div>
                                    <div style={{ fontFamily: "var(--serif)", fontSize: 20, marginTop: 8, letterSpacing: "-0.01em", lineHeight: 1.2 }}>
                                      {s.name}
                                    </div>
                                  </div>
                                </Link>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
