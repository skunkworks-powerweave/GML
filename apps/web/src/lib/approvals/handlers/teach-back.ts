// Approval handler for teach_back items. PLACEHOLDER until its area implements
// it: it refuses every submission and decision, so nothing can reach the
// queue through it. See ../types.ts for the contract.

import type { ApprovalHandler } from "../types";

export const teachBackHandler: ApprovalHandler = {
  type: "teach_back",
  deciderRoles: ["mentor", "observer", "programme_admin", "super_admin"],
  async canSubmit() {
    return false;
  },
  async onDecision() {
    throw new Error("teach_back approvals are not implemented yet");
  },
  async describe() {
    return new Map();
  },
};
