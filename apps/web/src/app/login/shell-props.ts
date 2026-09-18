/**
 * Props shared by the desktop and mobile login shells.
 *
 * Both are client components, so neither can read process.env or the request
 * URL. The page (a server component) resolves both and hands them down, which
 * also keeps AUTH_EMAIL_ENABLED off the wire -- a NEXT_PUBLIC_ variable would
 * let anyone read which deployments have a mail relay attached.
 */
export type LoginShellProps = {
  /** Same-site path to return to after sign-in; validated again server-side. */
  from: string;
  /** Whether outbound email works here — see lib/auth-email.ts. */
  emailEnabled: boolean;
};
