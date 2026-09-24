// /observation — Classroom Observation cycles list.
// Filter by kind (baseline | developmental | evaluative) and status — both
// reach the DB via URL searchParams so the filtered view is bookmarkable.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): port the filter strip
// from LMS GML Frontend/observation-list.jsx:41-65 into the live Next page.
// Before this spec the page had zero filter UI and just dumped the latest
// 80 cycles; now the filter chips submit GET against the same URL so the
// WHERE clause runs in Postgres, not over an already-fetched mock array.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, teachers, subjects } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom, cycleVisibilityFilter } from "@/lib/authz";

export const dynamic = "force-dynamic";

const KIND_CHIP: Record<string, string> = {
  baseline: "",
  developmental: "chip-indigo",
  evaluative: "chip-saffron",
};

const STATUS_LABEL: Record<string, string> = {
  nominated: "Nominated",
  pre_submitted: "Pre submitted",
  observed: "Observed",
  post_submitted: "Post submitted",
  complete: "Complete",
};

const CYCLE_STAGES = ["nominated", "pre_submitted", "observed", "post_submitted", "complete"] as const;

const STATUS_VALUES = new Set([
  "nominated",
  "pre_submitted",
  "observed",
  "post_submitted",
  "complete",
]);

const KIND_VALUES = new Set(["baseline", "developmental", "evaluative"]);

const STATUS_TABS = [
  { v: "all", l: "All" },
  { v: "nominated", l: "Nominated" },
  { v: "pre_submitted", l: "Pre-form in" },
  { v: "observed", l: "Observed" },
  { v: "post_submitted", l: "Post-form in" },
  { v: "complete", l: "Complete" },
];

const KIND_TABS = [
  { v: "all", l: "All kinds" },
  { v: "baseline", l: "Baseline" },
  { v: "developmental", l: "Developmental" },
  { v: "evaluative", l: "Evaluative" },
];

type SearchParams = Promise<{ status?: string; kind?: string }>;

function buildHref(status: string, kind: string): string {
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (kind !== "all") qs.set("kind", kind);
  const s = qs.toString();
  return s ? `/observation?${s}` : "/observation";
}

export default async function ObservationListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const statusFilter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : "all";
  const kindFilter = KIND_VALUES.has(sp.kind ?? "") ? sp.kind! : "all";

  // OWNERSHIP, BEFORE ANYTHING ELSE.
  //
  // This page previously built its WHERE from the filter chips alone, so with
  // no chip selected it served the 80 most recent cycles IN THE PROGRAMME to
  // whoever asked. The section gate does not prevent that: the gate is one
  // shared rotatable password, and a teacher is given it precisely so she can
  // open her OWN cycle. Having entered, she was shown every other teacher's
  // name and Hindi name, their subject and lesson topic, whether their cycle
  // was 'evaluative', its stage, and its real UUID -- the last being the
  // enumeration signal that assertCanAccessCycle's notFound()-over-403 choice
  // exists to suppress.
  //
  // The detail page at the far end of every one of those links was already
  // guarded. The list was missed.
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const visibility = await cycleVisibilityFilter(actor);

  // WHERE A CYCLE COMES FROM. Nothing in this module creates one -- the four
  // stages only ever UPDATE a cycle. The only INSERT in the repository was the
  // demo seed, and purge_demo_data.ts removes those rows at hand-over, so on a
  // real deployment this list starts empty. Cycles are nominated at
  // /observation/new (pickers, code minted for you) or bulk-loaded through the
  // admin grid (admin/entities/observation-cycles.ts).
  const canNominate = actor.role === "programme_admin" || actor.role === "super_admin";

  // Build the WHERE clause server-side — only emit predicates for filters
  // the user actively chose. The visibility predicate is NOT one of them: it
  // is unconditional and cannot be cleared by removing a chip.
  const conds: SQL[] = [];
  if (visibility) conds.push(visibility);
  if (statusFilter !== "all") {
    conds.push(eq(observationCycles.status, statusFilter as (typeof CYCLE_STAGES)[number]));
  }
  if (kindFilter !== "all") {
    const kindValue = kindFilter as "baseline" | "developmental" | "evaluative";
    conds.push(eq(observationCycles.kind, kindValue));
  }

  const rows = await db
    .select({
      id: observationCycles.id,
      code: observationCycles.code,
      kind: observationCycles.kind,
      status: observationCycles.status,
      scheduledAt: observationCycles.scheduledAt,
      topic: observationCycles.topic,
      videoMin: observationCycles.videoMin,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
      subjectName: subjects.name,
    })
    .from(observationCycles)
    .leftJoin(teachers, eq(observationCycles.teacherId, teachers.id))
    .leftJoin(subjects, eq(observationCycles.subjectId, subjects.id))
    .where(conds.length === 0 ? undefined : and(...conds))
    .orderBy(desc(observationCycles.scheduledAt))
    .limit(80);

  // Per-tab counts run as a single GROUP BY so the chips can show the
  // current totals even when a filter is active. One extra round-trip.
  //
  // BOTH aggregates carry the visibility predicate. They previously had no
  // WHERE at all, so even with the row query scoped the chips would still have
  // published programme-wide totals per status and per kind -- a smaller leak
  // than the rows, but the same one. /videos had to correct exactly this half
  // of the fix after the first attempt scoped only the rows.
  const statusCounts = await db
    .select({
      status: observationCycles.status,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(observationCycles)
    .where(visibility)
    .groupBy(observationCycles.status);

  const kindCounts = await db
    .select({
      kind: observationCycles.kind,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(observationCycles)
    .where(visibility)
    .groupBy(observationCycles.kind);

  const totalRows = statusCounts.reduce((acc, r) => acc + r.n, 0);
  const statusCount = (v: string) =>
    v === "all" ? totalRows : (statusCounts.find((c) => c.status === v)?.n ?? 0);
  const kindCount = (v: string) =>
    v === "all" ? totalRows : (kindCounts.find((c) => c.kind === v)?.n ?? 0);

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div className="label">Classroom observation</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Observation cycles</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 6 }}>
              A cycle has three steps: <b>Pre-form</b> from teacher → <b>Observation</b> (live or video) → <b>Post-debrief</b> with mentor.
              Every step is time-stamped and signed.
            </p>
          </div>
          {canNominate ? (
            <Link
              href="/observation/new"
              className="btn btn-primary"
              style={{ textDecoration: "none", whiteSpace: "nowrap" }}
            >
              Nominate cycle
            </Link>
          ) : null}
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <div
          className="card"
          style={{ display: "flex", padding: 10, gap: 16, alignItems: "center", flexWrap: "wrap" }}
        >
          <div style={{ display: "flex", gap: 4 }}>
            {STATUS_TABS.map((f) => {
              const active = statusFilter === f.v;
              return (
                <Link
                  key={f.v}
                  href={buildHref(f.v, kindFilter)}
                  className="btn btn-sm"
                  style={{
                    background: active ? "var(--ink)" : "transparent",
                    color: active ? "var(--paper)" : "var(--ink-2)",
                    borderColor: active ? "var(--ink)" : "transparent",
                    boxShadow: "none",
                    textDecoration: "none",
                  }}
                >
                  {f.l}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{statusCount(f.v)}</span>
                </Link>
              );
            })}
          </div>
          <div style={{ width: 1, height: 20, background: "var(--line)" }} />
          <div style={{ display: "flex", gap: 4 }}>
            {KIND_TABS.map((f) => {
              const active = kindFilter === f.v;
              return (
                <Link
                  key={f.v}
                  href={buildHref(statusFilter, f.v)}
                  className="btn btn-sm"
                  style={{
                    background: active ? "var(--ink-2)" : "transparent",
                    color: active ? "var(--paper)" : "var(--ink-2)",
                    borderColor: active ? "var(--ink-2)" : "transparent",
                    boxShadow: "none",
                    textDecoration: "none",
                  }}
                >
                  {f.l}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{kindCount(f.v)}</span>
                </Link>
              );
            })}
          </div>
        </div>

        <div className="card">
          {rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
              No observation cycles match this filter.
              {canNominate ? (
                <div style={{ fontSize: 12, marginTop: 8 }}>
                  <Link href="/observation/new">Nominate a cycle</Link> to start one.
                </div>
              ) : null}
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Teacher</th>
                  <th>Subject / Topic</th>
                  <th>Kind</th>
                  <th>Stage</th>
                  <th>Date</th>
                  <th>Video</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{c.code}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.teacherName ?? "—"}</div>
                      {c.teacherHindi ? (
                        <div className="deva" style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--deva)" }}>
                          {c.teacherHindi}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div>{c.subjectName ?? "—"}</div>
                      {c.topic ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{c.topic}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`chip ${KIND_CHIP[c.kind] ?? ""}`}>{c.kind}</span>
                    </td>
                    <td>
                      <CycleStage status={c.status} />
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {c.scheduledAt
                        ? new Date(c.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                        : <span style={{ color: "var(--ink-4)" }}>—</span>}
                    </td>
                    <td>
                      {c.videoMin ? (
                        <span style={{ fontSize: 12 }}>{c.videoMin}m</span>
                      ) : (
                        <span style={{ color: "var(--ink-4)" }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        href={`/observation/${c.id}`}
                        style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
                      >
                        ›
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function CycleStage({ status }: { status: string }) {
  const idx = (CYCLE_STAGES as readonly string[]).indexOf(status);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {CYCLE_STAGES.map((s, i) => (
        <div
          key={s}
          style={{
            width: 22,
            height: 5,
            borderRadius: 2,
            background:
              i <= idx
                ? i === CYCLE_STAGES.length - 1 && i <= idx
                  ? "var(--lichen)"
                  : "var(--ink)"
                : "var(--paper-3)",
          }}
        />
      ))}
      <span style={{ marginLeft: 6, fontSize: 11, color: "var(--ink-3)" }}>
        {STATUS_LABEL[status] ?? status.replace("_", " ")}
      </span>
    </div>
  );
}
