"use server";

import { redirect } from "next/navigation";
import { signInWithPassword, type SignInError } from "@/auth";
import { safeInternalPath } from "@/lib/safe-redirect";

/**
 * A code, rendered by ./login-error.tsx in the user's language. The English
 * sentences this used to carry were shown verbatim on the Hindi and Bhoti
 * login screens.
 */
export type LoginErrorCode = SignInError | "missing_fields";
export type LoginState = { error?: LoginErrorCode };


export async function loginAction(
  _prev: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "missing_fields" };
  }

  const { error } = await signInWithPassword(email, password);
  if (error) return { error };

  // Outside the try/catch that used to wrap this: redirect() signals by
  // throwing, and the old code caught that throw before re-raising it. Keeping
  // it out of any catch removes the chance of a future edit swallowing it.
  redirect(safeInternalPath(String(formData.get("from") ?? "")));
}
