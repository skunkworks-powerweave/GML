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
// `reset()` re-renders the segment without a full navigation, so a transient
// failure recovers in place and the user keeps their scroll position.
//
// `error.digest` is the ONLY detail shown. Next strips server error messages
// from production bundles deliberately -- they carry connection strings, host
// names and query text -- and replaces them with this digest, which is also
// written to the server log. Quoting it to the user is what lets an
// administrator find the matching line. The message itself is never rendered.

import { useEffect } from "react";
import Link from "next/link";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-600">
        This page couldn&rsquo;t load. It may be a temporary connection problem &mdash; try
        again in a moment.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-800"
        >
          Go to dashboard
        </Link>
      </div>
      {error.digest ? (
        <p className="text-xs text-neutral-400">
          Reference <code data-testid="error-digest">{error.digest}</code> &mdash; quote this
          when reporting the problem.
        </p>
      ) : null}
    </main>
  );
}
