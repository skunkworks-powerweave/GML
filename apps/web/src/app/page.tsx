import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";

/**
 * Rendered per request, never prerendered. Two independent reasons:
 *
 *  1. CORRECTNESS. This page branches on the session, but the build runs
 *     WITHOUT Supabase credentials, so auth() returned null before it ever
 *     touched cookies(). Next saw no dynamic API, froze the signed-out variant
 *     into index.html, and served that to everyone -- a signed-in user landing
 *     on / was told "Please sign in to continue". The bug only existed in the
 *     built image, which is why it survived every dev-server check.
 *
 *  2. CSP. proxy.ts issues a fresh per-request nonce, and a prerendered page
 *     carries whatever nonce existed at build time (none), so its inline
 *     scripts would be blocked by the very policy that protects it.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  const t = await getTranslations("home.root");
  const tBrand = await getTranslations("brand");
  const tAction = await getTranslations("action");
  const tRole = await getTranslations("role");
  const role = session?.user?.role;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 p-6">
      <header>
        <h1 className="text-3xl font-semibold">{tBrand("name")}</h1>
        <p className="text-neutral-600">{t("tagline")}</p>
      </header>

      {session?.user ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-6">
          <p className="text-lg">
            {t.rich("greeting", {
              name: session.user.name ?? session.user.email ?? "",
              b: (chunks) => <span className="font-medium">{chunks}</span>,
            })}
          </p>
          <p className="text-sm text-neutral-500">
            {/* The role by name, in the reader's language; it printed the slug. */}
            {t("role", { role: role && tRole.has(role) ? tRole(role) : (role ?? "") })}
          </p>
          <Link
            href="/dashboard"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm text-white"
          >
            {t("goToDashboard")}
          </Link>
        </section>
      ) : (
        <section className="rounded-lg border border-neutral-200 bg-white p-6">
          <p className="mb-3">{t("signInPrompt")}</p>
          <Link
            href="/login"
            className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm text-white"
          >
            {tAction("signIn")}
          </Link>
        </section>
      )}

      <footer className="text-xs text-neutral-500">
        {t("footer")}
      </footer>
    </main>
  );
}
