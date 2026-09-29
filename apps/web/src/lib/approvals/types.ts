// The contract every kind of approvable item implements.
//
// lib/approvals (./index.ts) owns the queue: it records a submission, checks
// who may decide, stores the decision, notifies both sides and audits. What a
// submission or decision DOES to the item -- set a session's approval_status,
// complete an observation cycle, create a login from an account request -- is
// the item's own handler (./handlers/*.ts), registered in ./registry.ts.

import type { ApprovalDecision, ApprovalItemType } from "@gml/db/schema";
import type { RoleName } from "@gml/shared/auth/roles";
import type { Actor, Db } from "@/lib/visibility";

/** A transaction handle, as db.transaction() passes it. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** How the queue shows an item: data, so not translated. */
export type ItemSummary = {
  /** e.g. the session's topic and date, the plan's name, the person's name. */
  title: string;
  /** A second line: class, subject, teacher. */
  subtitle?: string;
  /** Where the approver opens it. */
  href: string;
};

export type ApprovalHandler = {
  type: ApprovalItemType;
  /** Roles that may decide this kind of item at all. */
  deciderRoles: readonly RoleName[];
  /**
   * The decisions this kind of item takes, when not all three: a teach-back is
   * approved or sent back, never rejected; an account request is approved or
   * rejected, never sent back. decideApproval refuses any other, and the
   * decision form offers only these (decisionsFor in ./index.ts).
   */
  decisions?: readonly ApprovalDecision[];
  /**
   * May `actor` submit this item? Owner checks live here (a teacher submits
   * her own session only). Return false to refuse.
   */
  canSubmit(db: DbOrTx, actor: Actor, itemId: string): Promise<boolean>;
  /**
   * May `actor` decide it, beyond having a decider role? (A mentor reviews
   * only her own mentees' teach-backs.) Defaults to true.
   */
  canDecide?(db: DbOrTx, actor: Actor, itemId: string): Promise<boolean>;
  /** Called inside the submission's transaction, e.g. to mark the record pending. */
  onSubmit?(tx: Tx, itemId: string): Promise<void>;
  /** Called inside the decision's transaction: apply it to the item. */
  onDecision(tx: Tx, itemId: string, decision: ApprovalDecision, ctx: { actor: Actor; comment: string | null }): Promise<void>;
  /** Titles and links for the queue and the notifications. Missing ids are simply absent. */
  describe(db: DbOrTx, itemIds: string[]): Promise<Map<string, ItemSummary>>;
  /**
   * Who to tell that something is waiting. Defaults to every active user
   * holding one of `deciderRoles`.
   */
  approverUserIds?(db: DbOrTx, itemId: string): Promise<string[]>;
};
