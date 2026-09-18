import "server-only";
import { headers } from "next/headers";

/**
 * Is outbound email available for authentication flows?
 *
 * WHY THIS IS A FLAG AND NOT A PROBE. Under Supabase, SMTP is configured in the
 * Supabase dashboard, not in this application's environment -- so the app has
 * no way to observe whether a relay is attached. Supabase's built-in sender is
 * NOT a substitute: it is rate-limited to a couple of messages an hour and is
 * explicitly documented as being for testing only, so on a deployment with no
 * custom SMTP the honest answer is "email does not work here".
 *
 * Getting that answer wrong is worse than it sounds. A user who types their
 * address into a password-reset form, sees "check your inbox", and never
 * receives anything has no way to tell a broken deployment from a slow one. So
 * the flows below are switched OFF by default, and the UI says plainly that
 * resets go through an administrator.
 *
 * FOR IT: after configuring a custom SMTP provider under
 * Authentication -> Emails -> SMTP Settings in the Supabase dashboard, set
 *
 *     AUTH_EMAIL_ENABLED=true
 *
 * and redeploy. No code change is needed; magic-link sign-in and self-service
 * password reset light up at that point. See README-deploy.md.
 */
export function authEmailEnabled(): boolean {
  return String(process.env.AUTH_EMAIL_ENABLED ?? "").trim().toLowerCase() === "true";
}

/**
 * Absolute origin for building email redirect links.
 *
 * Derived from the request rather than hardcoded, because the old code fell
 * back to `http://localhost:3000` whenever APP_URL and NEXTAUTH_URL were unset
 * -- which they always were -- so every reset link it generated pointed at the
 * recipient's own machine.
 *
 * APP_URL still wins when set: behind a proxy chain the forwarded headers can
 * be rewritten by an intermediary, and a pinned origin is not guessable by a
 * caller sending a spoofed Host.
 */
export async function appOrigin(): Promise<string> {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}
