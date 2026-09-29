// Every approvable kind of item, and its handler (./types.ts).

import type { ApprovalItemType } from "@gml/db/schema";
import type { ApprovalHandler } from "./types";
import { assessmentHandler, lessonPlanHandler, sessionHandler } from "./handlers/records";
import { teachBackHandler } from "./handlers/teach-back";
import { observationSignoffHandler } from "./handlers/observation-signoff";
import { accountRequestHandler } from "./handlers/account-request";

export const APPROVAL_HANDLERS: Record<ApprovalItemType, ApprovalHandler> = {
  lesson_plan: lessonPlanHandler,
  session: sessionHandler,
  assessment: assessmentHandler,
  teach_back: teachBackHandler,
  observation_signoff: observationSignoffHandler,
  account_request: accountRequestHandler,
};
