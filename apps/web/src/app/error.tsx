"use client";

// Route-level error boundary.
//
// Before this file, ANY unhandled exception in a Server Component rendered
// Next's production error page: a blank screen with no message, no retry and no
// way back. On the target deployment -- a single EC2 box in Mumbai serving
// schools on intermittent Ladakh connectivity -- a timed-out database query is
// the single most likely fault a real user hits, and a blank page is the worst
// possible presentation of a transient one.
//
// "Try again" calls `unstable_retry()`, which re-fetches the segment from the
// server and then re-renders it, without a full navigation -- so a transient
// failure that has cleared recovers in place. This used to be `reset()`,
// which only re-renders from the payload the client already holds: for a
// server failure that payload is the error, so it could never recover.
//
// `error.digest` is the ONLY detail shown. Next strips server error messages
// from production bundles deliberately -- they carry connection strings, host
// names and query text -- and replaces them with this digest, which is also
// written to the server log. Quoting it to the user is what lets an
// administrator find the matching line. The message itself is never rendered.

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // The root layout provides these strings (home.client.routeError) in the
  // user's language: this boundary renders inside it, outside every other
  // layout and its provider.
  const t = useTranslations("home.client.routeError");
  useEffect(() => {
    // Structured so a log processor can find it. console.error is the only
    // sink available in a client component; the server has already logged the
    // same digest with the full stack.
    console.error("[route-error]", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="route-error"
    >
      <p className="text-5xl">!</p>
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-neutral-600">{t("body")}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white"
        >
          {t("tryAgain")}
        </button>
        <Link
          href="/dashboard"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-800"
        >
          {t("goToDashboard")}
        </Link>
      </div>
      {error.digest ? (
        <p className="text-xs text-neutral-400">
          {t.rich("reference", {
            digest: error.digest,
            code: (chunks) => <code data-testid="error-digest">{chunks}</code>,
          })}
        </p>
      ) : null}
    </main>
  );
}
