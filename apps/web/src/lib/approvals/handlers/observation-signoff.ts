// Approval handler for observation_signoff items. PLACEHOLDER until its area implements
// it: it refuses every submission and decision, so nothing can reach the
// queue through it. See ../types.ts for the contract.

import type { ApprovalHandler } from "../types";

export const observationSignoffHandler: ApprovalHandler = {
  type: "observation_signoff",
  deciderRoles: ["mentor", "programme_admin", "super_admin"],
  async canSubmit() {
    return false;
  },
  async onDecision() {
    throw new Error("observation_signoff approvals are not implemented yet");
  },
  async describe() {
    return new Map();
  },
};
