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
//
// Copy is in the admin namespace (i18n/locales/<locale>/admin.json, index.*);
// each data table's title is the grid's own, adminData.entities.<slug>.label
// (admin/labels.ts). The programme name is data and is shown as the
// administrator typed it.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireRole } from "@/lib/guards";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { entityLabel } from "@/admin/labels";
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
  const t = await getTranslations("admin");
  const tData = await getTranslations("adminData");
  // Role names as the users page shows them, not the enum codes.
  const roleLabel = (role: string) => (t.has(`client.roles.${role}`) ? t(`client.roles.${role}`) : role);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6" data-testid="admin-home-header">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("index.eyebrow", { year: academicYear })}
        </div>
        <h1 className="text-2xl font-semibold" data-testid="admin-programme-name">
          {programmeName}
        </h1>
        <p className="text-sm text-neutral-500">
          {t("index.intro")}
        </p>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("index.data")}
        </h2>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {entries.map(([slug, entity]) => (
            <li key={slug}>
              <Link
                href={`/admin/data/${slug}`}
                className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
              >
                <div className="text-sm font-medium">{entityLabel(tData, entity)}</div>
                <div className="text-xs text-neutral-500">
                  {t("index.entityMeta", { slug, roles: entity.readRoles.map(roleLabel).join(", ") })}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("index.system")}
        </h2>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <li>
            <Link
              href="/admin/users"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">{t("index.links.users.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.users.hint")}
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/audit"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">{t("index.links.audit.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.audit.hint")}
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/gates"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">{t("index.links.gates.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.gates.hint")}
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
              <div className="text-sm font-medium">{t("index.links.forms.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.forms.hint")}
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
              <div className="text-sm font-medium">{t("index.links.quizzes.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.quizzes.hint")}
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/scorm"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">{t("index.links.scorm.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.scorm.hint")}
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
              <div className="text-sm font-medium">{t("index.links.whatsappLog.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.whatsappLog.hint")}
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/system-settings"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">{t("index.links.systemSettings.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.systemSettings.hint")}
              </div>
            </Link>
          </li>
          <li>
            <Link
              href="/admin/transcode-jobs"
              className="block rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400"
            >
              <div className="text-sm font-medium">{t("index.links.transcodeJobs.title")}</div>
              <div className="text-xs text-neutral-500">
                {t("index.links.transcodeJobs.hint")}
              </div>
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
