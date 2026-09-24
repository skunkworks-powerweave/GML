import { z } from "zod";
import { observationCycles } from "@gml/db/schema";
import type { AdminEntity } from "../types";

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
