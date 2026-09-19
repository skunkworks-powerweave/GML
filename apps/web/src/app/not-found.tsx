// 404.
//
// Twenty call sites use `notFound()` -- every ownership check in lib/authz.ts
// among them, because an ownership failure must not confirm that the id exists.
// Until this file existed all of them landed on Next's built-in default: an
// unstyled "404 | This page could not be found." with no navigation and no way
// back into the application. That is the page a teacher sees when they follow a
// stale link, and it looked like the site was broken rather than the link.

import Link from "next/link";

export default function NotFound() {
  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="not-found-page"
    >
      <p className="text-5xl">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-neutral-600">
        This page doesn&rsquo;t exist, or you don&rsquo;t have access to it. If you followed a
        link from somewhere in the programme, it may be out of date.
      </p>
      <Link href="/dashboard" className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white">
        Go to dashboard
      </Link>
    </main>
  );
}
