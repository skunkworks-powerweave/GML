"use client";

// Spec 122 — page-header ⓘ button.
//
// Lives next to page titles in repo, observation, mentorship, rtt etc. One
// click opens HelpPanel anchored on the current page's primary topic
// (e.g. /repo/schools → "school", /rtt → "rtt"). The slug is provided by the
// page that mounts the button, so the component itself stays generic.
//
// Used in tandem with the `data-help-anchor="topbar-help"` discoverability
// hook the prototype's FTUX tour highlights.

import { helpFor } from "@/lib/help";
import { openHelp } from "./HelpPanel";

type HelpHeadbtnProps = {
  /** Dictionary slug to open on click. */
  k: string;
  /** Optional label override. Defaults to "Help on <title>". */
  label?: string;
};

export function HelpHeadbtn({ k, label }: HelpHeadbtnProps) {
  const entry = helpFor(k);
  const aria = label ?? `Help on ${entry?.title ?? k}`;
  return (
    <button
      type="button"
      data-help-headbtn={k}
      data-help-anchor="topbar-help"
      aria-label={aria}
      onClick={() => openHelp(k)}
      style={{
        marginLeft: 8,
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: "1px solid var(--line)",
        background: "var(--card-hi)",
        color: "var(--ink-2)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--serif)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        padding: 0,
      }}
    >
      i
    </button>
  );
}
