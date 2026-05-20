"use server";

import { signIn } from "@/auth";
import { AuthError } from "next-auth";

export type LoginState = { error?: string };

export async function loginAction(
  _prev: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("credentials", { email, password, redirectTo: "/dashboard" });
    return {};
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Invalid email or password" };
    }
    // Re-throw redirects so Next.js can handle them.
    throw err;
  }
}
