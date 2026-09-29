import "server-only";

// "Request an account": what happens between the public form on the login
// page and a working login.
//
//   submitAccountRequest   the public form (app/request-account) records the
//                          request and its pending approvals row together,
//                          and tells the programme admins
//   approveAccountRequest  a programme admin approves: the login is created
//                          as /admin/users creates one, recorded on the
//                          request, and only then is the approval decided;
//                          any failure undoes the login
//   rejectAccountRequest   a programme admin rejects, with the reason
//   accountRequestDetails  what the approvals pages show about each request
//
// THE LOGIN IS MADE THE WAY /admin/users MAKES ONE (createUserAction in
// app/(authenticated)/admin/users/actions.ts): Supabase Auth's admin
// createUser with the address confirmed (no confirmation email is coming --
// SMTP is deferred to IT) and the must-change-password flag set; the public
// users row upserted over the one the on_auth_user_created trigger writes;
// the profile removed before the login when anything has to be undone,
// because public.users.id references auth.users ON DELETE RESTRICT. It is a
// copy, not a call: that action returns messages for its own form and its
// governance test pins those steps in its own source. A change to one is a
// change to both.
//
// THE INITIAL PASSWORD is generated here and handed back to the approver's
// screen once. It is never stored (Supabase keeps only its hash), never
// audited, never logged and never put in a notification.

import { randomInt } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { accountRequests, approvals, schools, teachers, users, type ApprovalItemType } from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { notifyLocalized } from "@/lib/notify-localized";
import { MUST_CHANGE_PASSWORD } from "@/lib/password-policy";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { Actor, Db } from "@/lib/visibility";
import { decideApproval, type ApprovalResult } from "./index";
import {
  ACCOUNT_REQUEST_ROLES,
  AccountRequestStateError,
  accountRequestHandler,
  type AccountRequestRole,
} from "./handlers/account-request";

export { ACCOUNT_REQUEST_ROLES, type AccountRequestRole };

// ── the public request ───────────────────────────────────────────────────────

export type AccountRequestInput = {
  fullName: string;
  /** Lower-cased by the caller. */
  email: string;
  phone: string | null;
  schoolId: string | null;
  role: AccountRequestRole;
  message: string | null;
};

export type SubmitAccountRequestResult =
  | { recorded: true; requestId: string; approvalId: string }
  /** This address already has a request waiting (account_requests_one_pending_uq). */
  | { recorded: false; reason: "duplicate" };

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Active programme admins and super admins: who decides account requests. */
async function deciders(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.active, true),
        isNull(users.deletedAt),
        inArray(users.role, accountRequestHandler.deciderRoles as never),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Record a request from the public form, with its pending approvals request,
 * in one transaction, and tell the programme admins. A second request from an
 * address that already has one waiting records nothing.
 */
export async function submitAccountRequest(db: Db, input: AccountRequestInput): Promise<SubmitAccountRequestResult> {
  let ids: { requestId: string; approvalId: string };
  try {
    ids = await db.transaction(async (tx) => {
      const [request] = await tx
        .insert(accountRequests)
        .values({
          fullName: input.fullName,
          email: input.email,
          phone: input.phone,
          schoolId: input.schoolId,
          requestedRole: input.role,
          message: input.message,
        })
        .returning({ id: accountRequests.id });
      const [approval] = await tx
        .insert(approvals)
        .values({
          itemType: "account_request",
          itemId: request!.id,
          // What the person wrote is the request's note, as a teacher's note
          // is on what she submits.
          note: input.message,
          // Nobody: the person has no account yet.
          submittedByUserId: null,
        })
        .returning({ id: approvals.id });
      return { requestId: request!.id, approvalId: approval!.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { recorded: false, reason: "duplicate" };
    throw err;
  }

  await recordAudit({
    action: "account_request.submitted",
    entityType: "account_request",
    entityId: ids.requestId,
    // No actor on purpose: whoever may be signed in on this browser did not
    // make the request (and the address is not written here -- the request
    // row holds it).
    userId: null,
    metadata: { approvalId: ids.approvalId, requestedRole: input.role },
  });

  await notifyLocalized(
    db,
    "approvals",
    (await deciders(db)).map((userId) => ({
      userId,
      kind: "approval",
      entityType: "approval",
      entityId: ids.approvalId,
      text: (t) => ({
        subject: t("notify.submitted", { kind: t("kinds.account_request"), title: input.fullName }),
        body: input.message,
      }),
    })),
  );
  return { recorded: true, ...ids };
}

// ── what the approvals pages show ────────────────────────────────────────────

export type AccountRequestDetails = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  school: string | null;
  role: AccountRequestRole;
  message: string | null;
  status: string;
  decisionReason: string | null;
  createdUserId: string | null;
  /** Some login already uses this address: approving it would be refused. */
  emailHasLogin: boolean;
};

export async function accountRequestDetails(db: Db, ids: string[]): Promise<Map<string, AccountRequestDetails>> {
  const out = new Map<string, AccountRequestDetails>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: accountRequests.id,
      fullName: accountRequests.fullName,
      email: accountRequests.email,
      phone: accountRequests.phone,
      school: schools.name,
      role: accountRequests.requestedRole,
      message: accountRequests.message,
      status: accountRequests.status,
      decisionReason: accountRequests.decisionReason,
      createdUserId: accountRequests.createdUserId,
      emailHasLogin: sql<boolean>`exists (select 1 from users u where lower(u.email) = lower(${accountRequests.email}))`,
    })
    .from(accountRequests)
    .leftJoin(schools, eq(schools.id, accountRequests.schoolId))
    .where(inArray(accountRequests.id, ids));
  for (const r of rows) out.set(r.id, { ...r, role: r.role as AccountRequestRole, emailHasLogin: !!r.emailHasLogin });
  return out;
}

// ── deciding ─────────────────────────────────────────────────────────────────

/** What lib/approvals can answer with. */
type ApprovalError = Extract<ApprovalResult, { ok: false }>["error"];

export type ApproveAccountResult =
  | { ok: true; approvalId: string; userId: string; email: string; password: string }
  | { ok: false; error: ApprovalError }
  | { ok: false; error: "email_taken"; email: string }
  | { ok: false; error: "school_missing" }
  | { ok: false; error: "login_failed"; detail: string; leftBehind: boolean; email: string };

/**
 * An initial password to read out or send: 12 characters from an alphabet
 * without the look-alikes (0/O, 1/l/I), in three groups of four. About 70
 * bits, well inside the password policy (8 characters, 72 bytes).
 */
export function initialPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

type Loaded = {
  approval: typeof approvals.$inferSelect;
  request: typeof accountRequests.$inferSelect;
};

/** The pending account request behind `approvalId`, or why there is none to decide. */
async function loadPending(db: Db, approvalId: string): Promise<Loaded | { error: "not_found" | "not_pending" }> {
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval || approval.itemType !== "account_request") return { error: "not_found" };
  if (approval.status !== "pending") return { error: "not_pending" };
  const [request] = await db.select().from(accountRequests).where(eq(accountRequests.id, approval.itemId)).limit(1);
  if (!request) return { error: "not_found" };
  if (request.status !== "pending") return { error: "not_pending" };
  return { approval, request };
}

/** The claim on the request was lost: it was decided, or another approval is creating its login. */
class RequestTaken extends Error {}

type AdminClient = ReturnType<typeof supabaseAdmin>;

/**
 * Remove a login this module made and could not finish: the request's claim,
 * the teacher record, the profile, then the auth login. Never throws; true
 * when nothing is left behind.
 */
async function undoLogin(db: Db, admin: AdminClient, newId: string, requestId: string): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(accountRequests)
        .set({ createdUserId: null })
        .where(
          and(
            eq(accountRequests.id, requestId),
            eq(accountRequests.createdUserId, newId),
            eq(accountRequests.status, "pending"),
          ),
        );
      await tx.delete(teachers).where(eq(teachers.userId, newId));
      await tx.execute(sql`DELETE FROM public.users WHERE id = ${newId}::uuid`);
    });
  } catch (err) {
    console.error(`[account-requests] could not remove the profile of the half-created account ${newId}:`, err);
    return false;
  }
  try {
    const { error } = await admin.auth.admin.deleteUser(newId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[account-requests] could not remove the half-created login ${newId}:`, err);
    return false;
  }
}

/**
 * Approve an account request: create the login (and, for a teacher, her
 * teacher record at the requested school, linked to it), then decide the
 * approval. Returns the initial password for the approver to hand over.
 */
export async function approveAccountRequest(
  db: Db,
  input: { approvalId: string; actor: Actor; comment?: string | null },
): Promise<ApproveAccountResult> {
  // Before anything is created: who is asking, and is there anything to decide.
  if (!hasAnyRole(input.actor.role, accountRequestHandler.deciderRoles)) return { ok: false, error: "not_allowed" };
  const loaded = await loadPending(db, input.approvalId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { request } = loaded;
  const email = request.email.trim().toLowerCase();
  const role = request.requestedRole as AccountRequestRole;
  if (!(ACCOUNT_REQUEST_ROLES as readonly string[]).includes(role)) return { ok: false, error: "not_allowed" };

  if (role === "teacher") {
    const [school] = request.schoolId
      ? await db.select({ id: schools.id }).from(schools).where(eq(schools.id, request.schoolId)).limit(1)
      : [];
    if (!school) return { ok: false, error: "school_missing" };
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing) return { ok: false, error: "email_taken", email };

  const password = initialPassword();
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    // As /admin/users: without it GoTrue refuses password sign-in, and there
    // is no confirmation email to wait for.
    email_confirm: true,
    user_metadata: { name: request.fullName },
    // Someone else knows this password until the holder picks their own
    // (lib/password-policy.ts, enforced in proxy.ts).
    app_metadata: { [MUST_CHANGE_PASSWORD]: true },
  });
  if (error || !data?.user) {
    // A login made meanwhile (another admin, /admin/users) owns the address.
    if ((error as { code?: string } | null)?.code === "email_exists" || (error as { status?: number } | null)?.status === 422) {
      return { ok: false, error: "email_taken", email };
    }
    return { ok: false, error: "login_failed", detail: String(error?.message ?? "empty_response").slice(0, 200), leftBehind: false, email };
  }
  const newId = data.user.id;

  try {
    await db.transaction(async (tx) => {
      // The on_auth_user_created trigger has already written the profile as
      // an inactive teacher; this makes it what was asked for.
      await tx.execute(sql`
        INSERT INTO public.users (id, email, name, role, active, default_locale)
        VALUES (${newId}::uuid, ${email}, ${request.fullName}, ${role}::public.role, true, 'en')
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role,
              name = COALESCE(EXCLUDED.name, public.users.name),
              active = true,
              deleted_at = NULL,
              updated_at = now()
      `);
      if (role === "teacher") {
        await tx.insert(teachers).values({
          schoolId: request.schoolId!,
          fullName: request.fullName,
          phone: request.phone,
          userId: newId,
        });
      }
      // Claim the request for this login. Losing means it was decided, or
      // another approval got here first: undo, never overwrite.
      const claimed = await tx
        .update(accountRequests)
        .set({ createdUserId: newId })
        .where(
          and(
            eq(accountRequests.id, request.id),
            eq(accountRequests.status, "pending"),
            isNull(accountRequests.createdUserId),
          ),
        )
        .returning({ id: accountRequests.id });
      if (claimed.length !== 1) throw new RequestTaken();
    });
  } catch (err) {
    const undone = await undoLogin(db, admin, newId, request.id);
    if (err instanceof RequestTaken && undone) return { ok: false, error: "not_pending" };
    return { ok: false, error: "login_failed", detail: String(err).slice(0, 200), leftBehind: !undone, email };
  }

  // The login exists and is recorded on the request; now the decision. If it
  // does not go through, the login goes too.
  let failure: ApprovalError | "decision_failed" | null = null;
  try {
    const decided = await decideApproval(db, {
      approvalId: input.approvalId,
      decision: "approved",
      comment: input.comment,
      actor: input.actor,
    });
    if (!decided.ok) failure = decided.error;
  } catch (err) {
    if (err instanceof AccountRequestStateError) failure = "not_pending";
    else {
      console.error("[account-requests] the approval could not be recorded:", err);
      failure = "decision_failed";
    }
  }
  if (failure) {
    const undone = await undoLogin(db, admin, newId, request.id);
    if (!undone || failure === "decision_failed") {
      return { ok: false, error: "login_failed", detail: failure, leftBehind: !undone, email };
    }
    return { ok: false, error: failure };
  }

  await recordAudit({
    action: "account_request.approved",
    entityType: "account_request",
    entityId: request.id,
    userId: input.actor.id,
    // Never the password, in any form.
    metadata: { approvalId: input.approvalId, role, createdUserId: newId },
  });
  return { ok: true, approvalId: input.approvalId, userId: newId, email, password };
}

/** Reject an account request, with the reason (required). */
export async function rejectAccountRequest(
  db: Db,
  input: { approvalId: string; actor: Actor; comment?: string | null },
): Promise<ApprovalResult> {
  if (!hasAnyRole(input.actor.role, accountRequestHandler.deciderRoles)) return { ok: false, error: "not_allowed" };
  const loaded = await loadPending(db, input.approvalId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  let decided: ApprovalResult;
  try {
    decided = await decideApproval(db, {
      approvalId: input.approvalId,
      decision: "rejected",
      comment: input.comment,
      actor: input.actor,
    });
  } catch (err) {
    // An approval is creating the login right now.
    if (err instanceof AccountRequestStateError) return { ok: false, error: "not_pending" };
    throw err;
  }
  if (decided.ok) {
    await recordAudit({
      action: "account_request.rejected",
      entityType: "account_request",
      entityId: loaded.request.id,
      userId: input.actor.id,
      metadata: { approvalId: input.approvalId },
    });
  }
  return decided;
}

// ── one request's history ────────────────────────────────────────────────────

/** Every approvals row for one item, oldest first, with who sent and decided each. */
export async function approvalHistory(db: Db, itemType: ApprovalItemType, itemId: string) {
  return db
    .select({
      id: approvals.id,
      status: approvals.status,
      note: approvals.note,
      submittedAt: approvals.submittedAt,
      submittedBy: sql<string | null>`(select coalesce(u.name, u.email) from users u where u.id = ${approvals.submittedByUserId})`,
      decidedAt: approvals.decidedAt,
      decidedBy: sql<string | null>`(select coalesce(u.name, u.email) from users u where u.id = ${approvals.decidedByUserId})`,
      comment: approvals.comment,
    })
    .from(approvals)
    .where(and(eq(approvals.itemType, itemType), eq(approvals.itemId, itemId)))
    .orderBy(asc(approvals.submittedAt));
}
