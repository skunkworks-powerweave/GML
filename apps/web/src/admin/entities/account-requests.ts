import { z } from "zod";
import { accountRequests } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// "Request an account" from the login page (migration 0043), as a READ-ONLY
// list with CSV export. A request is approved or rejected at /approvals,
// which creates the login and the teacher record, or records the reason, and
// tells the applicant; a status changed here would do neither. So no role may
// write it through the grid (mutateRoles is empty). The form fields exist
// only because the grid's contract describes every table's required columns.
export const accountRequestsEntity: AdminEntity = {
  slug: "account-requests",
  // The prefix of its bulk_import / bulk_export audit actions (docs/audit-actions.md).
  auditName: "account_requests",
  table: accountRequests,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: [],
  displayColumns: [
    { key: "fullName" },
    { key: "email" },
    { key: "phone" },
    { key: "schoolId" },
    { key: "requestedRole" },
    { key: "status" },
    { key: "createdAt" },
    { key: "decidedByUserId" },
    { key: "decisionReason" },
  ],
  formSchema: z.object({
    fullName: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(254),
    phone: z.string().max(32).optional().nullable(),
    schoolId: z.string().uuid().optional().nullable(),
    requestedRole: z.enum(["teacher", "mentor", "observer"]).default("teacher"),
    message: z.string().max(4000).optional().nullable(),
    status: z.enum(["pending", "approved", "rejected"]).default("pending"),
    decisionReason: z.string().max(4000).optional().nullable(),
  }),
  formFields: ["fullName", "email", "phone", "schoolId", "requestedRole", "message", "status", "decisionReason"],
  describeRow: (r) => `account-request:${r.email ?? r.id}`,
};
