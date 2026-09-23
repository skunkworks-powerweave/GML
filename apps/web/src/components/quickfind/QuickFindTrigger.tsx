"use client";

// A button that opens QuickFind.
//
// QuickFind itself is mounted once, in the authenticated layout. Pages that
// want to offer a visible way in are usually async Server Components, which
// cannot carry an onClick -- /repo's "Find a record" button was a bare
// <button type="button"> with no handler and did nothing at all when clicked.
// This is the smallest client island that bridges the two.

import type { ReactNode } from "react";
import { QUICKFIND_OPEN_EVENT } from "./events";

export function QuickFindTrigger({
  children,
  className = "btn",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      data-testid="quickfind-trigger"
      onClick={() => window.dispatchEvent(new Event(QUICKFIND_OPEN_EVENT))}
    >
      {children}
    </button>
  );
}
