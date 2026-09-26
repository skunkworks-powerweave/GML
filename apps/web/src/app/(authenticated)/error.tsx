"use client";

// Error boundary INSIDE the authenticated shell.
//
// The root error.tsx catches everything, but it renders outside
// (authenticated)/layout.tsx, so a failure on one page tears down the sidebar,
// bottom tabs and navigation with it -- leaving a signed-in user stranded on a
// page with no way onward except the browser's back button. This boundary
// replaces only the page content, so the chrome survives and the user can
// simply click somewhere else.
//
// It deliberately does NOT render the digest in a monospace callout the way the
// root boundary does: inside the shell this is a content-area failure, and the
// surrounding navigation already tells the user where they are.
//
// "Try again" is `unstable_retry`, not `reset`. In Next 16 reset only clears
// the boundary's state and re-renders the children from the payload already
// on the client -- which, for a server failure, is the error itself -- so it
// could never recover from the "temporary connection problem" this page
// describes; measured live, three presses sent no request at all.
// unstable_retry refreshes the route and then resets (next/dist/client/
// components/error-boundary.js), so a failure that has cleared is picked up.

import { useEffect } from "react";

export default function AuthenticatedError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[page-error]", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div
      className="flex flex-col items-start gap-3 p-6"
      role="alert"
      data-testid="authenticated-error"
    >
      <h1 className="text-base font-semibold">This page couldn&rsquo;t load</h1>
      <p className="max-w-prose text-sm text-neutral-600">
        Something went wrong fetching this page. It may be a temporary connection problem.
        Other pages should still work.
      </p>
      <button
        type="button"
        onClick={() => unstable_retry()}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
      >
        Try again
      </button>
      {error.digest ? (
        <p className="text-xs text-neutral-400">
          Reference <code>{error.digest}</code>
        </p>
      ) : null}
    </div>
  );
}
