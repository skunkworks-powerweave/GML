// Which RTT subjects a viewer is shown: ONE predicate for every RTT surface
// (/rtt, the subject page, the progress tick, the open-quiz list and the
// dashboard's count of it, /rtt/progress and the webinar calendar).
//
// ── INACTIVE SUBJECTS (F43) ──────────────────────────────────────────────────
//
// The admin grid has an Active flag on RTT subjects and the self-paced hub
// honoured it, but /rtt listed, counted and linked every subject and the
// subject page never looked: retiring a subject changed nothing teachers saw.
// Only an administrator -- who may need to re-activate one -- still sees an
// inactive subject, marked as such.
//
// Takes the database as a parameter so the behaviour suite can run it.

import { eq, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rttSubjects } from "@gml/db/schema";
import type { Actor } from "@/lib/visibility";

type Db = NodePgDatabase<Record<string, unknown>>;

export type RttScope = {
  isAdmin: boolean;
  /** WHERE predicate on rtt_subjects; undefined means every subject. */
  subjectWhere: SQL | undefined;
};

export async function rttScope(_db: Db, actor: Actor): Promise<RttScope> {
  const isAdmin = actor.role === "programme_admin" || actor.role === "super_admin";
  return { isAdmin, subjectWhere: isAdmin ? undefined : eq(rttSubjects.active, true) };
}
