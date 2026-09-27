import "server-only";

// The password policy's complaint, in the user's language. Server actions
// return it straight to the form that asked. The rule itself is in
// ./password-policy.ts, which client components also import.

import { getTranslations } from "next-intl/server";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordPolicyProblem } from "./password-policy";

/** Why `password` is not acceptable, in the user's language, or null when it is. */
export async function passwordPolicyError(password: string): Promise<string | null> {
  const problem = passwordPolicyProblem(password);
  if (!problem) return null;
  const t = await getTranslations("password");
  return problem === "too_short" ? t("tooShort", { min: MIN_PASSWORD_LENGTH }) : t("tooLong", { max: MAX_PASSWORD_BYTES });
}
