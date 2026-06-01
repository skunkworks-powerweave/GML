// Admin index. Lists every entity registered in ADMIN_ENTITIES, plus links
// to /admin/audit and /admin/forms (which land in their own specs).

import Link from "next/link";
import { requireRole } from "@/lib/guards";
import { ADMIN_ENTITIES } from "@/admin/registry";

export const dynamic = "force-dynamic";

export default async function AdminIndexPage() {
  await requireRole(["programme_admin", "super_admin"]);

  const entries = Object.entries(ADMIN_ENTITIES);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-neutral-500">
          No-code data management. Every change is logged to the audit trail.
        </p>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Data
        </h2>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {entries.map(([slug, entity]) => (
            <li key={slug}>
              <Link
                href={`/admin/data/${slug}`}
                className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
              >
                <div className="text-sm font-medium">{entity.label}</div>
                <div className="text-xs text-neutral-500">
                  Slug: {slug} · roles: {entity.readRoles.join(", ")}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          System
        </h2>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <li>
            <Link
              href="/admin/audit"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">Audit log</div>
              <div className="text-xs text-neutral-500">
                Search every recorded action across the platform
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/gates"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">Section gates</div>
              <div className="text-xs text-neutral-500">
                Rotate gate passwords · super_admin only
              </div>
            </Link>
          </li>
          <li>
            <span className="block rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 text-neutral-400">
              <div className="text-sm font-medium">Forms & quizzes</div>
              <div className="text-xs">Lands in spec 073</div>
            </span>
          </li>
          <li>
            <span className="block rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 text-neutral-400">
              <div className="text-sm font-medium">Settings</div>
              <div className="text-xs">Lands in spec 071</div>
            </span>
          </li>
        </ul>
      </section>
    </main>
  );
}
