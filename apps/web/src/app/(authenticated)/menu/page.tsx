// /menu — the role's whole navigation, for a phone. The tab bar holds five
// or six destinations and a phone renders no sidebar, so everything else (a
// mentee's pairing and forms, the review queue, Forms & quizzes, the
// repository pages) had no mobile route (FR-28). The same items and labels as
// the desktop sidebar (NAV_BY_ROLE, Sidebar's translation keys).

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { NAV_BY_ROLE } from "@/config/nav";
import { ITEM_KEY, SECTION_KEY } from "@/components/nav/Sidebar";
import { Icon } from "@/components/nav/Icon";
import type { RoleName } from "@gml/shared/auth/roles";

export const metadata: Metadata = { title: "Menu" };

export default async function MenuPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const role = session.user.role as RoleName;
  const tNav = await getTranslations("nav");
  const tSection = await getTranslations("navSection");
  const sections = NAV_BY_ROLE[role] ?? NAV_BY_ROLE.teacher;

  return (
    <main>
      <div className="page-header">
        <h1 className="serif" style={{ fontSize: 24 }}>{tNav("menu")}</h1>
      </div>
      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {sections.map((section) => {
          const sectionKey = SECTION_KEY[section.section];
          const sectionLabel = sectionKey ? tSection(sectionKey) : section.section;
          return (
            <nav key={section.section} aria-label={sectionLabel}>
              <div className="label" style={{ marginBottom: 6 }}>{sectionLabel}</div>
              <ul className="card" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {section.items.map((item, i) => {
                  const itemKey = item.labelKey ?? ITEM_KEY[item.id];
                  return (
                    <li key={item.id} style={{ borderTop: i === 0 ? "none" : "1px solid var(--line)" }}>
                      <Link
                        href={item.href}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          minHeight: 48,
                          padding: "0 14px",
                          color: "var(--ink)",
                          textDecoration: "none",
                          fontSize: 15,
                        }}
                      >
                        <Icon name={item.icon} size={18} />
                        <span style={{ flex: 1 }}>{itemKey ? tNav(itemKey) : item.label}</span>
                        <Icon name="chev" size={14} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          );
        })}
      </div>
    </main>
  );
}
