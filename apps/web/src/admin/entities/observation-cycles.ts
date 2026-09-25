import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { observationCycles, users } from "@gml/db/schema";
import type { AdminDb, AdminEntity } from "../types";

/**
 * The observer must be a live observer account -- the rule
 * /observation/new's nominateCycleAction applies. lib/authz.ts scopes an
 * observer to observer_id = me, so a cycle pointed at a mentor, a teacher or a
 * deactivated account is one nobody can run. The grid and CSV import skipped
 * it and accepted a mentor's id.
 *
 * Judged only when the observer is being SET: on create, or on an update that
 * changes it. It used to run on every update, so once a signed-off cycle's
 * observer account was closed, no edit to that cycle (a topic typo) could be
 * saved without reassigning the observer -- the one change the lock refuses.
 */
async function liveObserver(
  db: AdminDb,
  row: Record<string, unknown>,
  before?: Record<string, unknown>,
): Promise<Record<string, string> | null> {
  const id = row.observerId;
  if (typeof id !== "string") return null; // zod already required it
  if (before && id === before.observerId) return null;
  const [found] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.role, "observer"), eq(users.active, true), isNull(users.deletedAt)))
    .limit(1);
  return found ? null : { observerId: "must be an active observer account" };
}

/**
 * Once a cycle is past "nominated", forms have been written ABOUT a teacher
 * under a kind: the lesson plan, the observer's rubric, the summary. Changing
 * teacherId then moves that record onto someone else -- and read access with
 * it, since lib/authz.ts follows cycle.teacher_id -- and changing kind turns
 * an evaluative record into a baseline one. Deleting it would erase the forms'
 * parent (their FKs refuse that since 0031, but the refusal should say why).
 *
 * The observer is fixed from "observed" on, once the rubric exists: authz
 * grants an observer the cycle through cycle.observer_id as it grants the
 * teacher through teacher_id, so reassigning it moved access to the rubric,
 * the observer dashboard counts and the completion notices onto someone who
 * never watched the lesson. Before that (nominated, pre_submitted) it is still
 * a booking and can be moved; the stages after it can be finished by a mentor
 * or an administrator, so no cycle is left stuck.
 *
 * Code, schedule, subject and topic stay editable, and every change is
 * audited with its previous value.
 */
const OBSERVER_FIXED_FROM: ReadonlySet<unknown> = new Set(["observed", "post_submitted", "complete"]);
const LOCKED_NOUN = { teacherId: "teacher", kind: "kind", observerId: "observer" } as const;

function lockAfterNomination(
  op: "update" | "delete",
  before: Record<string, unknown>,
  next?: Record<string, unknown>,
): string | null {
  if (before.status === "nominated") return null;
  if (op === "delete") {
    return `This cycle is at stage "${String(before.status)}" and has work recorded under it; it cannot be deleted from the grid.`;
  }
  const locked = OBSERVER_FIXED_FROM.has(before.status)
    ? (["teacherId", "kind", "observerId"] as const)
    : (["teacherId", "kind"] as const);
  for (const field of locked) {
    if (next && field in next && next[field] !== before[field]) {
      return `This cycle is at stage "${String(before.status)}": its ${LOCKED_NOUN[field]} can no longer be changed.`;
    }
  }
  return null;
}

// Observation cycles — the nomination record every classroom observation hangs off.
//
// WHY THIS ENTITY EXISTS. The Observation module was inert on any real
// deployment. The only INSERT into observation_cycles in the repository was the
// demo seed (packages/db/src/scripts/seed.ts), and purge_demo_data.ts deletes
// exactly those demo cycles before hand-over. The module's own actions only
// ever UPDATE a cycle -- they advance it nominated → pre → observed → post →
// complete -- so after the purge nobody could nominate an observation:
// /observation stayed empty and every observation dashboard counter stayed 0.
// Same failure, and the same fix, as entities/rtt-sessions.ts.
//
// Test: tests/behaviour/admin-entities.test.ts.
export const observationCyclesEntity: AdminEntity = {
  slug: "observation-cycles",
  label: "Observation Cycles",
  table: observationCycles,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  // These are the rows /observation keeps behind its password; the grid must
  // not be the way round it. Test: tests/behaviour/admin-section-gate.test.ts.
  gate: "observation",
  validate: liveObserver,
  // Test: tests/behaviour/admin-cycle-lock.test.ts.
  guardMutation: lockAfterNomination,
  displayColumns: [
    { key: "code", label: "Code" },
    { key: "teacherId", label: "Teacher" },
    { key: "observerId", label: "Observer (user)" },
    { key: "kind", label: "Kind" },
    { key: "scheduledAt", label: "Scheduled" },
    { key: "topic", label: "Topic" },
    { key: "status", label: "Stage" },
  ],
  formSchema: z.object({
    // NOT NULL + UNIQUE varchar(48). Without the guard a long value comes back
    // as a raw Postgres "value too long" through the generic action.
    code: z.string().trim().min(1).max(48),
    // teachers.id, NOT NULL, ON DELETE restrict.
    teacherId: z.string().uuid(),
    // users.id -- NOT teachers.id or mentors.id. REQUIRED although the column
    // is nullable: lib/authz.ts scopes an observer to observer_id = me, so a
    // cycle with no observer is invisible to every observer and its observer
    // stage can never be reached.
    observerId: z.string().uuid(),
    // NOT NULL with no database default.
    kind: z.enum(["baseline", "developmental", "evaluative"]),
    // Required: /observation orders by scheduled_at DESC, which Postgres sorts
    // NULLS FIRST, so an undated cycle would pin itself to the top of the list.
    scheduledAt: z.coerce.date(),
    // Rendered by /observation and /repo/teacher/[id]; without them every
    // cycle created here would show "—" in those columns.
    subjectId: z.string().uuid().optional().nullable(),
    topic: z.string().max(240).optional().nullable(),
    // NO `status`. The stage is advanced only by observation/[cycleId]/actions.ts,
    // whose guarded transition checks the current stage and writes that stage's
    // form in the same transaction. Letting the grid set it would allow a cycle
    // to be marked complete with no forms behind it, and a zod default here
    // would reset a live cycle to "nominated" on every edit. New rows take the
    // column default, "nominated".
  }),
  formFields: ["code", "teacherId", "observerId", "kind", "scheduledAt", "subjectId", "topic"],
  fields: {
    observerId: { label: "Observer", userRoles: ["observer"] },
    subjectId: { label: "Subject" },
  },
  describeRow: (r) => `observation-cycle:${r.code ?? r.id}`,
};
