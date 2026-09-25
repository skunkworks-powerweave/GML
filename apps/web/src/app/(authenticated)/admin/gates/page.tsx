// /admin/gates — Section-gate password management surface.
//
// Workflow Run 9 Tier A (spec 115) — Ports the JSX prototype
// admin.jsx::SectionGates (lines 285-325) into a real Drizzle-backed admin
// page. The prototype rendered four gate cards (observation, mentorship,
// assessment, admin) each with a "Rotate" + "Share" button row that had no
// backend. This page wires both buttons to /api/admin/gates/[slug]/rotate
// and /api/admin/gates/[slug]/share, gated by super_admin only (SM-2: gate
// rotation is the single most privileged section-gate action; only the 1-2
// super_admins in the deployment can rotate).
//
// The page is a server component (a few grouped reads per render) that hands
// off the per-row rotation/share UX to a single client component
// (RotateControls). Stats columns (last_rotated, attempts_30d, failures_30d)
// are computed at render time from section_gates + audit_log so the
// dashboard tells the truth without a stats table.

import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  sectionGates,
  sectionGateGrants,
  auditLog,
  users,
} from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { RotateControls } from "./rotate-controls";

export const dynamic = "force-dynamic";

// Mirror the section_gate_slug enum from packages/db/src/schema/enums.ts.
// Order matches the JSX prototype card order.
const GATES: { slug: string; label: string; description: string }[] = [
  {
    slug: "observation",
    label: "Classroom Observation",
    description: "Gates /observation/* — observer + mentor + admin only.",
  },
  {
    slug: "mentorship",
    label: "Mentorship",
    description: "Gates /mentorship/* — mentor + admin only.",
  },
  {
    slug: "admin",
    label: "Audit log",
    description: "Gates /admin/audit — the append-only record of every mutation.",
  },
];

// `tkt` and `ttt` are DELIBERATELY ABSENT, though they remain members of the
// section_gate_slug enum.
//
// They described themselves as gating /rtt/tkt/* and /rtt/ttt/*. Neither route
// has ever existed. So this page offered an administrator a Rotate button and a
// Share button for two passwords that admitted nobody to anything, and reported
// grant counts for them -- which is worse than omitting them, because rotating
// a gate is the revocation action, and an operator rotating these in response
// to a suspected leak would believe they had revoked something.
//
// The enum members stay: removing them is a migration, and section_gate_grants
// rows may reference them historically. What is removed is the UI that implied
// they were live.

export default async function AdminGatesPage() {
  await requireRole(["super_admin"]);

  // SM-9 view-side audit — record that an admin opened the rotation surface.
  // The audit_log query downstream is a normal SELECT, no PII.
  void recordAudit({
    action: "gate.password.surface_viewed",
    entityType: "section_gate",
  });

  // Per-gate stats: ONE grouped query per table for all the gates, run
  // together. This was four queries per gate chained one after another --
  // twelve round trips per render, and two separate 30-day counts per gate
  // over audit_log, re-reading the same gate-attempt rows six times on a
  // table that only grows. The grouped count uses the same
  // (action, created_at) index; failures are a FILTER of the same scan.
  const slugs = GATES.map((g) => g.slug as "mentorship");
  // Window computed by the database, not the app process: this is compared
  // against DB timestamps, so using now() removes any app/DB clock skew and
  // keeps an impure clock read out of the render path.
  const cutoff = sql`now() - interval '30 days'`;
  const [latestRows, grantRows, attemptRows] = await Promise.all([
    db
      .selectDistinctOn([sectionGates.slug], {
        slug: sectionGates.slug,
        version: sectionGates.version,
        rotatedAt: sectionGates.rotatedAt,
        rotatedByUserId: sectionGates.rotatedByUserId,
      })
      .from(sectionGates)
      .where(inArray(sectionGates.slug, slugs))
      .orderBy(sectionGates.slug, desc(sectionGates.version)),
    db
      .select({ slug: sectionGateGrants.gateSlug, activeGrants: sql<number>`count(*)::int` })
      .from(sectionGateGrants)
      .where(and(inArray(sectionGateGrants.gateSlug, slugs), sql`${sectionGateGrants.expiresAt} > now()`))
      .groupBy(sectionGateGrants.gateSlug),
    db
      .select({
        slug: auditLog.entityId,
        attempts30d: sql<number>`count(*)::int`,
        failures30d: sql<number>`(count(*) filter (where ${auditLog.action} IN ('gate.attempt.fail', 'gate_fail')))::int`,
      })
      .from(auditLog)
      .where(
        and(
          sql`${auditLog.action} IN ('gate.attempt.success', 'gate.attempt.fail', 'gate_pass', 'gate_fail')`,
          inArray(auditLog.entityId, slugs),
          sql`${auditLog.createdAt} > ${cutoff}`,
        ),
      )
      .groupBy(auditLog.entityId),
  ]);
  const latestBySlug = new Map(latestRows.map((r) => [r.slug as string, r]));
  const grantsBySlug = new Map(grantRows.map((r) => [r.slug as string, r.activeGrants]));
  const attemptsBySlug = new Map(attemptRows.map((r) => [r.slug ?? "", r]));
  const rows = GATES.map((g) => ({
    ...g,
    latest: latestBySlug.get(g.slug),
    activeGrants: Number(grantsBySlug.get(g.slug) ?? 0),
    attempts30d: Number(attemptsBySlug.get(g.slug)?.attempts30d ?? 0),
    failures30d: Number(attemptsBySlug.get(g.slug)?.failures30d ?? 0),
  }));

  // Build the share-recipient picker dataset — admins + mentors with a phone
  // number on file. Anything without a phone can't receive a WhatsApp deep
  // link, so we omit them to keep the dropdown short.
  const candidates = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
    })
    .from(users)
    .where(
      sql`${users.active} = true AND ${users.phone} IS NOT NULL AND ${users.role} IN ('mentor', 'programme_admin', 'super_admin')`,
    )
    .orderBy(users.email)
    .limit(50);

  const recipients = candidates
    .filter((c) => Boolean(c.phone))
    .map((c) => ({
      id: c.id,
      label: `${c.name ?? c.email} · ${c.role}`,
    }));

  // Pull the rotator email for each gate's "last rotated by" line.
  const rotatorIds = Array.from(
    new Set(
      rows
        .map((r) => r.latest?.rotatedByUserId ?? null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const rotatorById = new Map<string, string>();
  if (rotatorIds.length > 0) {
    const rotators = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, rotatorIds));
    for (const r of rotators) {
      rotatorById.set(r.id, r.name ?? r.email);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header>
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          System
        </div>
        <h1 className="mt-1 font-serif text-2xl">Section gates</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Rotating codes restrict access to sensitive sections even after
          login. Rotate every 30 days; share over a secure channel only.
          Each rotation invalidates every active grant for the slug — every
          authorised user must re-enter the new password.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {rows.map((g) => {
          const rotatedBy = g.latest?.rotatedByUserId
            ? rotatorById.get(g.latest.rotatedByUserId) ?? "—"
            : "—";
          return (
            <article
              key={g.slug}
              className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4"
              data-gate-slug={g.slug}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-serif text-lg">{g.label}</h2>
                <code className="font-mono text-xs text-neutral-500">
                  {g.slug}
                </code>
              </div>
              <p className="text-xs text-neutral-500">{g.description}</p>

              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Last rotated
                  </dt>
                  <dd className="font-mono">
                    {g.latest?.rotatedAt
                      ? g.latest.rotatedAt.toISOString().slice(0, 10)
                      : "never"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Version
                  </dt>
                  <dd className="font-mono">v{g.latest?.version ?? 1}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Active grants
                  </dt>
                  <dd>{g.activeGrants}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Attempts (30d)
                  </dt>
                  <dd>{g.attempts30d}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Failures (30d) · rotated by
                  </dt>
                  <dd
                    className={
                      g.failures30d > 0
                        ? "font-semibold text-red-700"
                        : "text-emerald-700"
                    }
                  >
                    {g.failures30d} · {rotatedBy}
                  </dd>
                </div>
              </dl>

              <RotateControls
                slug={g.slug}
                label={g.label}
                recipients={recipients}
              />
            </article>
          );
        })}
      </div>
    </main>
  );
}
