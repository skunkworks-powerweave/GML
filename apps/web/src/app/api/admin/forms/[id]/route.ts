// PUT /api/admin/forms/[id]
// Role-gated to programme_admin + super_admin. Validates that the body parses
// as JSON, updates the feedback_forms row, bumps the version, and records an
// audit entry of action `form.schema.update`.
//
// Spec 152 (admin-grid-improvements, Workflow Run 14 MEDIUM audit closure) —
// the previous shipped code SELECTed the existing row, computed `nextVersion`
// in JS, then UPDATEd. Under concurrent PUTs both requests could read
// version "2" and both write "3", trampling each other and leaving
// `feedback_forms_kind_audience_version_uq` (the unique index in
// packages/db/src/schema/mentorship.ts) to throw a 500 on the loser — or,
// worse, allow both to succeed when audience/kind differ enough that the
// uniqueness constraint doesn't fire. The fix wraps the SELECT + UPDATE
// pair in `db.transaction(async (tx) => { ... })` and re-reads the existing
// row with a row-level lock via `.for("update")`. Postgres SELECT … FOR
// UPDATE blocks every other transaction trying to acquire the same lock
// until commit, serialising the read-then-write so the second writer sees
// the freshly-bumped version and computes "3" → "4" instead of trampling.
// The recordAudit() fires AFTER the transaction commits so the audit log
// only records successful version bumps.

import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@gml/db";
import { feedbackForms } from "@gml/db/schema";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { FormSchemaSchema } from "@/lib/forms/schema";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["programme_admin", "super_admin"] as const;

/**
 * Pure version-bump helper. Exported for the governance and behaviour tests.
 *
 *   "1"   → "2"
 *   "2"   → "3"
 *   "1.0" → "1.1"
 *   "2.7" → "2.8"
 *   "endline-1" → "endline-2"   (trailing number incremented)
 *   "draft-Q2"  → "draft-Q3"
 *   "draft"     → "draft-2"     (no trailing number)
 *
 * THE VERSION IS PART OF A URL. The runner's slug is
 * `${kind}-${audience}-${version}`, and the non-numeric path used to return
 * `${prev}+1`: editing the seeded "endline-1" or "schoolvisit-1" produced
 * "endline-1+1", the runner received that segment percent-encoded, its lookup
 * never matched, and the form vanished for every user with no way back short
 * of SQL. The result is always drawn from [A-Za-z0-9._-]; any other character
 * already in a stored version becomes "-".
 */
export function bumpVersion(prev: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(prev);
  if (m) {
    const major = Number(m[1]);
    if (m[2] === undefined) {
      return String(major + 1);
    }
    const minor = Number(m[2]);
    return `${major}.${minor + 1}`;
  }
  const safe = prev.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "v";
  const trailing = /^(.*?)(\d+)$/.exec(safe);
  if (trailing) return `${trailing[1]}${Number(trailing[2]) + 1}`;
  return `${safe}-2`;
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasAnyRole(session.user.role, [...ALLOWED_ROLES])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  // A uuid, checked here: a malformed id reached the uuid column, Postgres
  // raised 22P02, and the 500 below carried its message to the client.
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const raw = await req.text();
  if (!raw.trim()) {
    return NextResponse.json(
      { error: "empty_body", message: "Request body is empty." },
      { status: 400 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return NextResponse.json(
      { error: "invalid_json", message: (e as Error).message },
      { status: 400 },
    );
  }

  // A SCHEMA THE RUNNERS CAN DRAW. Parsing was the only check, so
  // `{"fields": {...}}` was stored and every open of the form was a 500 for
  // every user, and `42` stored a form with no questions that still
  // submitted. Refused before anything is locked or a version is used up; the
  // issues tell the editor which path is wrong. lib/forms/schema.ts.
  const checked = FormSchemaSchema.safeParse(parsed);
  if (!checked.success) {
    return NextResponse.json(
      { error: "invalid_schema", issues: checked.error.issues.slice(0, 20) },
      { status: 400 },
    );
  }
  const schema = checked.data;

  // Spec 152 — race-safe version bump. We wrap the SELECT + UPDATE pair in
  // `db.transaction(async (tx) => { ... })` and acquire a row-level lock on
  // the existing row via `.for("update")`. Postgres serialises every other
  // transaction trying to lock the same row, so two concurrent PUTs can no
  // longer both read "1" and both write "2" — the second writer blocks on
  // the first's lock, then re-reads the freshly-bumped "2" and writes "3".
  // The transaction returns the resolved (prevVersion, nextVersion) pair so
  // the post-commit audit hook records the actual transition that landed.
  let txResult: { prevVersion: string; nextVersion: string } | null = null;
  let notFound = false;
  try {
    txResult = await db.transaction(async (tx) => {
      // SELECT … FOR UPDATE — re-reads the row inside the transaction and
      // holds a row-level lock until commit. Drizzle's pg query builder
      // exposes this via `.for("update")` on the select chain.
      const locked = await tx
        .select({
          id: feedbackForms.id,
          version: feedbackForms.version,
          kind: feedbackForms.kind,
          audience: feedbackForms.audience,
        })
        .from(feedbackForms)
        .where(eq(feedbackForms.id, id))
        .limit(1)
        .for("update");
      const existing = locked[0];
      if (!existing) {
        notFound = true;
        return null;
      }
      // Step past a version another row of this (kind, audience) already
      // holds -- "endline-1" -> "endline-2" when an "endline-2" was published
      // separately -- rather than hitting feedback_forms_kind_audience_version_uq
      // and answering 500.
      let nextVersion = bumpVersion(existing.version);
      for (let i = 0; i < 20; i++) {
        const [taken] = await tx
          .select({ id: feedbackForms.id })
          .from(feedbackForms)
          .where(
            and(
              eq(feedbackForms.kind, existing.kind),
              eq(feedbackForms.audience, existing.audience),
              eq(feedbackForms.version, nextVersion),
              ne(feedbackForms.id, id),
            ),
          )
          .limit(1);
        if (!taken) break;
        nextVersion = bumpVersion(nextVersion);
      }
      await tx
        .update(feedbackForms)
        .set({ schema, version: nextVersion })
        .where(eq(feedbackForms.id, id));
      return { prevVersion: existing.version, nextVersion };
    });
  } catch (e) {
    // Logged here, not returned: the driver's message is not for the client.
    console.error("[admin/forms] schema update failed", { id, err: e });
    return NextResponse.json({ error: "transaction_failed" }, { status: 500 });
  }

  if (notFound || !txResult) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // SM-1 — audit every mutation; metadata captures the version transition so an
  // admin reviewing /admin/audit can chase regressions back to the schema.
  // Spec 152 — the audit fires AFTER the transaction commits so the log only
  // records successful version bumps. Best-effort `void` — audit failure
  // never rolls back a committed rotation (same pattern as spec 148).
  void recordAudit({
    action: "form.schema.update",
    entityType: "feedback_forms",
    entityId: id,
    metadata: {
      prevVersion: txResult.prevVersion,
      nextVersion: txResult.nextVersion,
    },
  });

  return NextResponse.json(
    { ok: true, version: txResult.nextVersion },
    { status: 200 },
  );
}
