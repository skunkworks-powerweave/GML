"use server";

import { redirect } from "next/navigation";
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
    // Spec 170 — Workflow Run 16 post-audit hardening. auth.ts throws
    // `AccountLockedError` (a CredentialsSignin subclass with
    // `code = "account_locked"`) when the lockout window is active.
    // Detect that distinct shape and bounce to `/forbidden?reason=locked`
    // so the user sees the retry-after copy rather than the generic
    // "wrong password" string. Other CredentialsSignin failures
    // (bad email, bad password, rate-limit deny, redis-down) collapse
    // to the generic credential-failure message (the existing
    // behaviour — we don't want to leak which of those caused the
    // miss, that's the spec 141 fail-closed contract).
    if (err instanceof AuthError) {
      const code = (err as AuthError & { code?: string }).code;
      if (code === "account_locked") {
        redirect("/forbidden?reason=locked");
      }
      return { error: "Invalid email or password" };
    }
    // Re-throw redirects so Next.js can handle them.
    throw err;
  }
}
