// Topbar (desktop). Breadcrumbs + bell + lang picker + user pill.
// 1:1 port from `shell.jsx::Topbar`. ⌘K Quick-Find (028), Help (029), FTUX (030)
// are explicitly cut from v2; their slots stay empty visually.

import { signOut } from "@/auth";
import type { RoleName } from "@gml/shared/auth/roles";
import { Icon } from "./Icon";

type TopbarProps = {
  user: { name?: string | null; email?: string | null; role: RoleName; image?: string | null };
  breadcrumbs?: string[];
};

const ROLE_LABEL: Record<RoleName, string> = {
  super_admin: "Super Admin",
  programme_admin: "Programme Admin",
  mentor: "Mentor",
  observer: "Observer",
  teacher: "Teacher",
};

function initials(name?: string | null, email?: string | null): string {
  const src = name ?? email ?? "?";
  const parts = src.replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.|Mohd\.)\s+/i, "").trim().split(/\s+/);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export function Topbar({ user, breadcrumbs = [] }: TopbarProps) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 18px",
        borderBottom: "1px solid var(--line)",
        background: "var(--paper)",
        position: "sticky",
        top: 0,
        zIndex: 10,
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Breadcrumbs */}
      <nav style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}>
        {breadcrumbs.length === 0 ? (
          <span style={{ color: "var(--ink-3)" }}>—</span>
        ) : (
          breadcrumbs.map((crumb, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 ? <span style={{ color: "var(--ink-4)" }}>›</span> : null}
              <span style={{ color: i === breadcrumbs.length - 1 ? "var(--ink)" : "var(--ink-3)", fontWeight: i === breadcrumbs.length - 1 ? 500 : 400 }}>
                {crumb}
              </span>
            </span>
          ))
        )}
      </nav>

      {/* Right cluster */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        {/* Bell — count badge wired in spec 070 (inbox) */}
        <button
          type="button"
          aria-label="Notifications"
          style={{
            position: "relative",
            background: "transparent",
            border: "1px solid transparent",
            padding: 6,
            borderRadius: "var(--r-2)",
            color: "var(--ink-2)",
          }}
        >
          <Icon name="chat" size={16} />
        </button>

        {/* Language picker — wired to /api/user-prefs in spec 071. Static for now. */}
        <details style={{ position: "relative" }}>
          <summary
            style={{
              listStyle: "none",
              cursor: "pointer",
              padding: "6px 8px",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              fontSize: 12,
              color: "var(--ink-2)",
              background: "var(--card-hi)",
            }}
          >
            EN
          </summary>
          <ul
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 4px)",
              listStyle: "none",
              margin: 0,
              padding: 4,
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              boxShadow: "var(--shadow-2)",
              minWidth: 140,
              zIndex: 20,
            }}
          >
            <li style={{ padding: "6px 10px", fontSize: 12 }}>English</li>
            <li style={{ padding: "6px 10px", fontSize: 12 }}>हिन्दी</li>
            <li style={{ padding: "6px 10px", fontSize: 12, fontFamily: "var(--deva)" }}>Ladakhi (لد)</li>
          </ul>
        </details>

        {/* User pill */}
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            title={`Sign out ${user.email ?? ""}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px 4px 4px",
              border: "1px solid var(--line)",
              borderRadius: 999,
              background: "var(--card-hi)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "var(--ink)",
                color: "var(--paper)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--sans)",
              }}
            >
              {initials(user.name, user.email)}
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", fontSize: 11 }}>
              <span style={{ color: "var(--ink)", fontWeight: 500 }}>{user.name ?? user.email}</span>
              <span style={{ color: "var(--ink-3)" }}>{ROLE_LABEL[user.role]}</span>
            </span>
          </button>
        </form>
      </div>
    </header>
  );
}
