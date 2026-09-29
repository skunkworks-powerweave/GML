import { z } from "zod";
import { approvals, APPROVAL_ITEM_TYPES } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// The approvals queue's history (migration 0043), as a READ-ONLY list with
// CSV export: every request, who sent it, who decided it and why. Decisions
// are taken at /approvals, where lib/approvals applies them to the item,
// notifies the submitter and audits them in one transaction. A row written
// here would be a decision that did none of that, so no role may add, edit,
// delete or import (mutateRoles is empty: every write path refuses, and the
// grid shows no write control). The form fields exist only because the grid's
// contract describes every table's required columns.
export const approvalsEntity: AdminEntity = {
  slug: "approvals",
  table: approvals,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: [],
  displayColumns: [
    { key: "itemType" },
    { key: "status" },
    { key: "submittedByUserId" },
    { key: "submittedAt" },
    { key: "decidedByUserId" },
    { key: "decidedAt" },
    { key: "comment" },
  ],
  formSchema: z.object({
    itemType: z.enum(APPROVAL_ITEM_TYPES),
    itemId: z.string().uuid(),
    status: z.enum(["pending", "approved", "changes_requested", "rejected"]).default("pending"),
    note: z.string().max(4000).optional().nullable(),
    comment: z.string().max(4000).optional().nullable(),
  }),
  formFields: ["itemType", "itemId", "status", "note", "comment"],
  describeRow: (r) => `approval:${r.itemType}/${r.itemId}`,
};
