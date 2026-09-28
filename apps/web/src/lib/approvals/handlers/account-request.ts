// Approval handler for account_request items. PLACEHOLDER until its area implements
// it: it refuses every submission and decision, so nothing can reach the
// queue through it. See ../types.ts for the contract.

import type { ApprovalHandler } from "../types";

export const accountRequestHandler: ApprovalHandler = {
  type: "account_request",
  deciderRoles: ["programme_admin", "super_admin"],
  async canSubmit() {
    return false;
  },
  async onDecision() {
    throw new Error("account_request approvals are not implemented yet");
  },
  async describe() {
    return new Map();
  },
};
