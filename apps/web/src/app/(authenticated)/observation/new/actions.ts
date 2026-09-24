"use server";

// nominateCycleAction — create an observation cycle from /observation/new.
//
// WHY THIS EXISTS. Nothing in the product created an observation cycle: the
// four stage actions in ../[cycleId]/actions.ts only ever UPDATE one, and the
// only INSERT in the repository was the demo seed, whose rows the documented
// purge deletes at hand-over. The admin grid (admin/entities/observation-cycles.ts)
// is now a write path too, but it asks for raw UUIDs -- and the observer's is a
// users.id, which no screen displays. This is the path the people who run
// observations actually use: pickers instead of pasted ids, and the code minted
// for them.
//
// Validation is the grid entity's own formSchema, so the two write paths cannot
// disagree about what a valid cycle is. Audited as `admin.row.create` on
// `observation-cycles`, the same action the grid writes (docs/audit-actions.md),
// with `via` recording which surface did it.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, users } from "@gml/db/schema";
import { observationCyclesEntity } from "@/admin/entities/observation-cycles";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/authz";
import { assertSectionGate } from "@/lib/gates";
import { withAudit } from "@/lib/audit";
import { cycleCodePrefix, nextCycleCode } from "@/lib/observation/cycle-code";

const NOMINATE_ROLES = ["programme_admin", "super_admin"] as const;

async function mintCode(year: number): Promise<string> {
  const rows = await db
    .select({ code: observationCycles.code })
    .from(observationCycles)
    .where(like(observationCycles.code, `${cycleCodePrefix(year)}%`));
  return nextCycleCode(
    year,
    rows.map((r) => r.code),
  );
}

function field(formData: FormData, key: string): string | undefined {
  const v = formData.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export async function nominateCycleAction(formData: FormData): Promise<void> {
  const session = await requireRole([...NOMINATE_ROLES]);
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // A server action runs BEFORE any layout renders, so observation/layout.tsx's
  // gate never sees this request. Same reasoning as ../[cycleId]/actions.ts.
  await assertSectionGate(actor.id, "observation", "/observation/new");

  const scheduledRaw = field(formData, "scheduledAt");
  const scheduled = scheduledRaw ? new Date(scheduledRaw) : null;
  const year =
    scheduled && !Number.isNaN(scheduled.getTime())
      ? scheduled.getUTCFullYear()
      : new Date().getUTCFullYear();

  const candidate = {
    code: await mintCode(year),
    teacherId: field(formData, "teacherId"),
    observerId: field(formData, "observerId"),
    kind: field(formData, "kind"),
    scheduledAt: scheduledRaw,
    subjectId: field(formData, "subjectId"),
    topic: field(formData, "topic"),
  };
  const parsed = observationCyclesEntity.formSchema.safeParse(candidate);
  if (!parsed.success) {
    const which = String(parsed.error.issues[0]?.path[0] ?? "form");
    redirect(`/observation/new?error=invalid&field=${encodeURIComponent(which)}`);
  }
  const values = parsed.data as typeof observationCycles.$inferInsert;

  // The observer must be a live observer account. authz scopes an observer to
  // observer_id = me, so pointing a cycle at a deactivated or non-observer
  // account creates a cycle nobody can run.
  const [observer] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, values.observerId as string),
        eq(users.role, "observer"),
        eq(users.active, true),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!observer) redirect("/observation/new?error=observer");

  const insert = (row: typeof values) =>
    withAudit(
      async () => {
        const [created] = await db
          .insert(observationCycles)
          .values(row)
          .returning({ id: observationCycles.id });
        return created?.id ?? null;
      },
      {
        action: "admin.row.create",
        entityType: observationCyclesEntity.slug,
        entityIdFrom: (id) => id,
        metadata: {
          op: "create",
          via: "observation/new",
          row: observationCyclesEntity.describeRow?.(row as Record<string, unknown>),
        },
      },
    )();

  // Two administrators nominating at the same moment can mint the same code;
  // UNIQUE(code) refuses the second. Re-mint once rather than failing a form
  // the user filled in correctly.
  let createdId: string | null = null;
  let failure: "duplicate" | "failed" | null = null;
  for (let attempt = 0; attempt < 2 && !createdId; attempt += 1) {
    try {
      const row = attempt === 0 ? values : { ...values, code: await mintCode(year) };
      createdId = await insert(row);
      failure = null;
    } catch (err) {
      failure = (err as { code?: string } | null)?.code === "23505" ? "duplicate" : "failed";
      if (failure === "failed") break;
    }
  }
  if (!createdId) redirect(`/observation/new?error=${failure ?? "failed"}`);

  revalidatePath("/observation");
  redirect(`/observation/${createdId}`);
}
