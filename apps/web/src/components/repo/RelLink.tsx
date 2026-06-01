// RelLink — relational chip-link used across /repo/* routes.
// Ports the JSX prototype's `RelLink` (repository.jsx lines 24-30): a Chip
// styled like the LMS Chip component but clickable. Server-component-safe
// (renders a Next.js <Link> only, no event handlers), so it can be embedded
// inside any RSC.

import Link from "next/link";
import type { ReactNode } from "react";
import { chipColorFor, hrefForEntity, type WikiKind } from "@/lib/wiki";

export type RelLinkProps = {
  kind: WikiKind;
  id: string;
  label: ReactNode;
  /** Optional Hindi gloss — rendered alongside the label in the deva font (SM-7). */
  hindiLabel?: string | null;
  /** Optional `subjects.color` value (only used when kind === "subject"). */
  subjectColor?: string | null;
  /** Override the default chip background/ink (rarely needed — for callers that
   *  already know the entity colour, e.g. a session row that shows its subject
   *  chip with the subject's mapped colour). */
  bg?: string;
  ink?: string;
  /** Stop the chip from stealing clicks from a wrapping row link. */
  stopPropagation?: boolean;
};

export function RelLink({
  kind,
  id,
  label,
  hindiLabel,
  subjectColor,
  bg,
  ink,
  stopPropagation: _stopPropagation,
}: RelLinkProps) {
  const colour = chipColorFor(kind, subjectColor);
  const background = bg ?? colour.bg;
  const foreground = ink ?? colour.ink;
  return (
    <Link
      href={hrefForEntity(kind, id)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        background,
        color: foreground,
        borderRadius: 999,
        fontSize: 11,
        lineHeight: 1.4,
        fontWeight: 500,
        letterSpacing: "0.02em",
        textDecoration: "none",
        border: "1px solid var(--hairline)",
        cursor: "pointer",
      }}
    >
      <span>{label}</span>
      {hindiLabel ? (
        <span
          style={{
            fontFamily: "var(--deva)",
            color: "var(--ink-3)",
            fontSize: 11,
          }}
        >
          {hindiLabel}
        </span>
      ) : null}
    </Link>
  );
}
