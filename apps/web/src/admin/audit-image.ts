// What an admin-grid update or delete writes into audit_log about the row.
//
// The grid used to record only the NEW values of an update (describeRow of
// what was submitted) and `{ op: "delete" }` for a delete, so the append-only
// log could not say what a signed-off observation cycle had been, or whom it
// was about, once someone edited or removed it. These helpers turn the row
// read inside the write's transaction into a before-image and a diff.
//
// PII entities (SM-9, `piiAudited`) never copy values into the log: an update
// records which fields changed, a delete keeps only the row's ids and links.

import type { AdminEntity } from "./types";

/** A value in a form both sides of a comparison, and JSON, agree on. */
function comparable(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function jsonable(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

/**
 * `{ changes: { field: { from, to } } }` over the fields the write sets, or
 * `{ changedFields: [...] }` for a PII entity. Unchanged fields are left out.
 */
export function updateAudit(
  entity: AdminEntity,
  before: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const changed = Object.keys(next).filter((k) => comparable(before[k]) !== comparable(next[k]));
  if (entity.piiAudited) return { changedFields: changed };
  return {
    changes: Object.fromEntries(changed.map((k) => [k, { from: jsonable(before[k]), to: jsonable(next[k]) }])),
  };
}

/**
 * The row as it was, for a delete's audit entry. Timestamps of the row's own
 * bookkeeping are dropped; a PII entity keeps only its id and foreign keys
 * (which class, which school), never a child's name or guardian.
 */
export function deleteImage(entity: AdminEntity, before: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(before).filter((k) => k !== "createdAt" && k !== "updatedAt");
  const kept = entity.piiAudited ? keys.filter((k) => k === "id" || /Id$/.test(k)) : keys;
  return Object.fromEntries(kept.map((k) => [k, jsonable(before[k])]));
}

/**
 * The row label (entity.describeRow) for an audit entry, or nothing for a PII
 * entity: the learners label is `learner:<child's name>`, which is exactly
 * what the rule above keeps out of the log.
 */
export function auditRowLabel(entity: AdminEntity, row: Record<string, unknown>): string | undefined {
  return entity.piiAudited ? undefined : entity.describeRow?.(row);
}

/**
 * Thrown inside a grid write's transaction to refuse it with a reason.
 * `rowId` names the refused row, so a delete's redirect can carry the row
 * rather than the sentence (actions.ts gridErrorQuery).
 */
export class MutationRefused extends Error {
  constructor(
    message: string,
    readonly rowId?: string,
  ) {
    super(message);
  }
}
