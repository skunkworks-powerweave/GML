"use client";

// The sign-in error, in the language the person picked on the login page.
//
// loginAction returns a code (see ./actions.ts); the sentence lives in the
// locale bundles under login.error.*. Both shells render this, so the desktop
// and mobile screens cannot drift into saying different things.

import { useTranslations } from "next-intl";
import type { LoginErrorCode } from "./actions";
import type { LinkErrorCode } from "./shell-props";

export function LoginError({ code, fontSize = 12 }: { code?: LoginErrorCode | LinkErrorCode; fontSize?: number }) {
  const t = useTranslations("login");
  if (!code) return null;
  return (
    <p style={{ fontSize, color: "var(--rust)" }} role="alert">
      {t(`error.${code}`)}
    </p>
  );
}
