"use client";

// A nav link that knows whether it is the current page. The shells are
// rendered by the authenticated layout, and Next does not re-render a layout
// on client navigation, so an active item computed there stayed on the page
// first loaded: after one click the highlight and aria-current="page" named
// the wrong page (FR-29). The pathname is read here, where it follows the
// navigation; `serverActive` is the layout's answer, used only when there is
// no pathname to read.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { activeNavIdFor, activeTabIdFor } from "@/config/nav";
import type { RoleName } from "@gml/shared/auth/roles";

type Props = {
  role: RoleName;
  id: string;
  /** Sidebar items and bottom tabs have separate ids. */
  kind: "sidebar" | "tab";
  href: string;
  serverActive: boolean;
  style: CSSProperties;
  /** Merged over `style` while this is the current page. */
  activeStyle: CSSProperties;
  "data-help-anchor"?: string;
  children: ReactNode;
};

export function ActiveNavLink({ role, id, kind, serverActive, style, activeStyle, children, ...link }: Props) {
  const pathname = usePathname();
  const active = pathname ? (kind === "tab" ? activeTabIdFor : activeNavIdFor)(role, pathname) === id : serverActive;
  return (
    <Link {...link} aria-current={active ? "page" : undefined} style={active ? { ...style, ...activeStyle } : style}>
      {children}
    </Link>
  );
}
