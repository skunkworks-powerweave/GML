// /login/reset — choose a new password.
//
// Reached from a Supabase recovery email, which lands on /auth/confirm first
// (/auth/callback for a link from the default template); that route redeems
// the one-time link for a session and forwards here. So by the time this page
// renders, the caller is authenticated and there is no token in the URL to
// protect, lose, or leak through a Referer header.
//
// This used to be a client page that read `?token=` from the query string and
// POSTed it to /api/auth/reset-password. Both are gone -- see reset/actions.ts
// for what was wrong with that endpoint.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, recoverySessionState } from "@/auth";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  const signedIn = await auth();
  // Only a session that came from an emailed link, recently, may set a
  // password without the current one (recoverySessionState in auth.ts).
  // Anyone else who is signed in is sent to Settings, which asks for it --
  // the same door, with the check.
  const recovery = signedIn ? await recoverySessionState() : "signed_out";
  if (recovery === "not_recovery") redirect("/settings");
  const session = recovery === "recovery" ? signedIn : null;
  const t = await getTranslations("login");

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--paper)",
      }}
    >
      <div style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginBottom: 8 }}>
          {t("reset.title")}
        </h1>

        {session ? (
          <>
            <p
              style={{
                fontSize: 13,
                color: "var(--ink-3)",
                marginBottom: 20,
                lineHeight: 1.5,
              }}
            >
              {t("reset.signedInAs", { email: session.user.email ?? "" })}
            </p>
            <ResetPasswordForm />
          </>
        ) : (
          <>
            <div
              role="alert"
              data-testid="reset-link-invalid"
              style={{
                marginTop: 16,
                marginBottom: 20,
                padding: "12px 14px",
                border: "1px solid var(--saffron)",
                background: "var(--saffron-soft)",
                borderRadius: "var(--r-2)",
                fontSize: 13,
                color: "var(--ink-2)",
                lineHeight: 1.5,
              }}
            >
              <strong>{t("reset.invalidTitle")}</strong>
              <br />
              {t("reset.invalidHelp")}
            </div>
            <Link href="/login/forgot" style={{ fontSize: 13, color: "var(--ink-2)" }}>
              {t("reset.requestNew")}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
