"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/auth";

export type LoginState = { error?: string };

/**
 * Where to send the user after a successful sign-in.
 *
 * proxy.ts puts the originally-requested path in `?from=`, and that value is
 * attacker-controllable: anyone can send a staff member a link to
 * `/login?from=https://evil.example/harvest`. Accepting it verbatim would turn
 * the login page into an open redirect off the back of a real authentication,
 * which is the shape phishing wants most.
 *
 * So: same-site absolute paths only. It must start with a single "/" and not
 * "//" (protocol-relative, which browsers resolve to a foreign origin) and not
 * "/\" (which some parsers normalise the same way). Anything else -- including
 * a full URL that happens to point back at us -- falls back to /dashboard.
 * Bouncing to the dashboard is a minor annoyance; the alternative is not.
 */
function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/")) return "/dashboard";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/dashboard";
  // Never bounce back to the login page itself -- that reads as a failed
  // sign-in even though it succeeded.
  if (raw === "/login" || raw.startsWith("/login/")) return "/dashboard";
  return raw;
}

export async function loginAction(
  _prev: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const { error } = await signInWithPassword(email, password);
  if (error) return { error };

  // Outside the try/catch that used to wrap this: redirect() signals by
  // throwing, and the old code caught that throw before re-raising it. Keeping
  // it out of any catch removes the chance of a future edit swallowing it.
  redirect(safeNext(String(formData.get("from") ?? "")));
}
