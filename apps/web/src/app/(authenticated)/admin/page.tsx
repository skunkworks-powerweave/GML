// Admin index. Lists every entity registered in ADMIN_ENTITIES, plus links
// to /admin/audit and /admin/forms (which land in their own specs).
//
// Spec 168 — the page header used to hardcode "Goldenmile RTT" as the programme
// name and offered no academic-year context. Both values now come from
// `system_settings` (the singleton row spec 124 created) so an operator who
// edits the row at /admin/system-settings sees the change reflected here
// immediately. Fail-shape: when the row is missing (pre-bootstrap) we fall
// back to the schema defaults (Goldenmile RTT / 2026-27) so the page never
// renders a blank header.

import Link from "next/link";
import { requireRole } from "@/lib/guards";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { getSystemSettings } from "@/lib/system-settings";

export const dynamic = "force-dynamic";

export default async function AdminIndexPage() {
  await requireRole(["programme_admin", "super_admin"]);

  const entries = Object.entries(ADMIN_ENTITIES);

  // Spec 168 — surface programmeName + academicYear instead of the
  // hardcoded "Goldenmile RTT". The defaults below match the schema
  // defaults so an unbootstrapped DB still renders sensibly.
  const settings = await getSystemSettings();
  const programmeName = settings?.programmeName ?? "Goldenmile RTT";
  const academicYear = settings?.academicYear ?? "2026-27";

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6" data-testid="admin-home-header">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Admin · {academicYear}
        </div>
        <h1 className="text-2xl font-semibold" data-testid="admin-programme-name">
          {programmeName}
        </h1>
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
              href="/admin/users"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">Users</div>
              <div className="text-xs text-neutral-500">
                Create accounts, set roles, deactivate &middot; programme_admin and above
              </div>
            </Link>
          </li>
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
          {/* Forms & quizzes shipped. This was still rendered as a greyed-out
              dashed placeholder reading "Lands in spec 073" while /admin/forms
              and /admin/quizzes were both fully implemented and linked from the
              sidebar -- so the admin index told an administrator a working
              feature did not exist yet. */}
          <li>
            <Link
              href="/admin/forms"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">Feedback forms</div>
              <div className="text-xs text-neutral-500">
                Form templates and their schemas
              </div>
            </Link>
          </li>
          {/* Quizzes had NO link anywhere in the product. The only reference to
              /admin/quizzes was from its own [id] page, which cannot be reached
              with zero quizzes -- so the surface existed and was unreachable
              except by typing the URL. */}
          <li>
            <Link
              href="/admin/quizzes"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">Quizzes</div>
              <div className="text-xs text-neutral-500">
                Create a quiz and write its questions
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/scorm"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">SCORM packages</div>
              <div className="text-xs text-neutral-500">
                SCORM 1.2 modules for RTT subjects · learners&apos; completion and scores
              </div>
            </Link>
          </li>
          {/* /admin/whatsapp-log had no entry here at all, despite being the
              operator surface for the programme's PRIMARY video ingest path. */}
          <li>
            <Link
              href="/admin/whatsapp-log"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">WhatsApp ingest log</div>
              <div className="text-xs text-neutral-500">
                Incoming videos · unmatched submissions
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/system-settings"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">System settings</div>
              <div className="text-xs text-neutral-500">
                Programme · video pipeline · notifications · backups — super_admin only
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/transcode-jobs"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">Transcode jobs</div>
              <div className="text-xs text-neutral-500">
                Inspect the dead-letter queue · retry or drop failed transcodes
              </div>
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
