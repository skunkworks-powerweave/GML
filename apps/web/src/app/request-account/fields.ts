// What the "Request an account" form and its action agree on. Kept out of
// ./actions.ts, which as a "use server" module may export only async
// functions, and free of server imports, because ./request-form.tsx runs in
// the browser.

import type { AccountRequestRole } from "@/lib/approvals/handlers/account-request";

export type RequestAccountField = "fullName" | "email" | "phone" | "school" | "role" | "message";

export type RequestAccountState = {
  /** The neutral confirmation. */
  done?: boolean;
  /** Nothing was recorded; try again later. */
  error?: "rate_limited" | "unavailable";
  /** Fields to correct (login.requestAccount.invalid.<field>). */
  invalid?: RequestAccountField[];
  /** What was typed, so a refused form comes back filled in. */
  values?: Partial<Record<RequestAccountField, string>>;
};

/** The hidden field: a person never sees it, a form-filling bot fills it in. */
export const HONEYPOT_FIELD = "website";

/** The roles the form offers, in its order (account_requests_role_check). */
export const REQUESTABLE_ROLES = ["teacher", "mentor", "observer"] as const satisfies readonly AccountRequestRole[];
