// Approval handler for observation_signoff items: the sign-off of an
// observation cycle, requested when the teacher submits her post-observation
// form (the cycle is then post_submitted). The item id is the cycle's id.
//
//   who submits   anyone who may see the cycle (the teacher herself, or whoever
//                 submitted the post form on her behalf), while it is
//                 post_submitted
//   who decides   the teacher's actively paired mentor, or a programme / super
//                 admin -- and only while they hold the Observation section
//                 password: deciding from /approvals is a write to the
//                 observation record, and the section password guards every
//                 write to it, not just the reading of its pages (see
//                 observation/[cycleId]/actions.ts). Without a live grant the
//                 request is not in their queue at all.
//   the decision  lib/observation/cycle-signoff.ts: approved completes and
//                 locks the cycle; changes requested or rejected send it back
//                 to "observed" so the teacher can revise the post form.
//
// WHAT THE QUEUE AND THE INBOX SAY. The approvals queue prints `title` in the
// inbox messages it writes ("... waiting for approval: <title>"), and the inbox
// is outside the Observation section, so the title must say nothing that
// section's password guards -- not the cycle's code, its teacher, its kind or
// its date (lib/observation/notify.ts). It is a short reference to the cycle
// instead. The code, teacher and kind are in `subtitle`, which only the queue
// shows, and the queue lists these requests only to deciders holding the
// section password (canDecide).
//
// See ../types.ts for the contract.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { mentorPairings, mentors, observationCycles, teachers, users } from "@gml/db/schema";
import { completeCycle, sendBackCycle } from "@/lib/observation/cycle-signoff";
import { activeGrant, cycleVisibility, isAdmin, mentorIdFor, type Db } from "@/lib/visibility";
import type { ApprovalHandler, DbOrTx, ItemSummary } from "../types";

/** "#1a2b3c4d": which cycle, without anything the section password guards. */
export function cycleReference(cycleId: string): string {
  return `#${cycleId.replace(/-/g, "").slice(0, 8)}`;
}

async function cycleRow(db: DbOrTx, cycleId: string) {
  const [row] = await db
    .select({ teacherId: observationCycles.teacherId, status: observationCycles.status })
    .from(observationCycles)
    .where(eq(observationCycles.id, cycleId))
    .limit(1);
  return row ?? null;
}

async function activeMentorUserIds(db: DbOrTx, teacherId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: mentors.userId })
    .from(mentorPairings)
    .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
    .where(and(eq(mentorPairings.teacherId, teacherId), eq(mentorPairings.status, "active"), isNotNull(mentors.userId)));
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
}

export const observationSignoffHandler: ApprovalHandler = {
  type: "observation_signoff",
  deciderRoles: ["mentor", "programme_admin", "super_admin"],

  async canSubmit(db, actor, itemId) {
    if (!(await activeGrant(db as Db, actor.id, "observation"))) return false;
    const visible = await cycleVisibility(db as Db, actor);
    const [row] = await db
      .select({ status: observationCycles.status })
      .from(observationCycles)
      .where(and(eq(observationCycles.id, itemId), ...(visible ? [visible] : [])))
      .limit(1);
    return row?.status === "post_submitted";
  },

  async canDecide(db, actor, itemId) {
    if (!(await activeGrant(db as Db, actor.id, "observation"))) return false;
    const cycle = await cycleRow(db, itemId);
    if (!cycle) return false;
    if (isAdmin(actor)) return true;
    if (actor.role !== "mentor") return false;
    const mentorId = await mentorIdFor(db as Db, actor);
    if (!mentorId) return false;
    const [pair] = await db
      .select({ id: mentorPairings.id })
      .from(mentorPairings)
      .where(
        and(
          eq(mentorPairings.mentorId, mentorId),
          eq(mentorPairings.teacherId, cycle.teacherId),
          eq(mentorPairings.status, "active"),
        ),
      )
      .limit(1);
    return Boolean(pair);
  },

  async onDecision(tx, itemId, decision, ctx) {
    if (decision === "approved") await completeCycle(tx, itemId, ctx.actor);
    else await sendBackCycle(tx, itemId, decision, ctx);
  },

  async describe(db, itemIds) {
    const out = new Map<string, ItemSummary>();
    if (itemIds.length === 0) return out;
    const rows = await db
      .select({
        id: observationCycles.id,
        code: observationCycles.code,
        kind: observationCycles.kind,
        teacher: teachers.fullName,
      })
      .from(observationCycles)
      .leftJoin(teachers, eq(teachers.id, observationCycles.teacherId))
      .where(inArray(observationCycles.id, itemIds));
    for (const r of rows) {
      out.set(r.id, {
        title: cycleReference(r.id),
        subtitle: [r.code, r.teacher, r.kind].filter(Boolean).join(" · "),
        href: `/observation/${r.id}`,
      });
    }
    return out;
  },

  async approverUserIds(db, itemId) {
    const cycle = await cycleRow(db, itemId);
    if (!cycle) return [];
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.active, true), eq(users.role, "programme_admin")));
    return [...new Set([...(await activeMentorUserIds(db, cycle.teacherId)), ...admins.map((a) => a.id)])];
  },
};
