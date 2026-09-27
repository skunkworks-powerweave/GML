// /admin/system-settings — five-section platform configuration surface.
//
// Spec 124 (Workflow Run 10 frontend-parity) — ports the JSX prototype
// tweaks-panel.jsx admin settings panel (Programme / Video pipeline /
// Notifications / Backups & retention / status display) into a real
// Drizzle-backed admin page. Closes the deviation noted in spec 071 where the
// surface was deferred because no system_settings table existed.
//
// The page is a server component. The form posts to an inline server action
// (`updateSystemSettings`) which validates with the same zod schema as
// /api/admin/system-settings PUT and audits "system_settings.update". Using a
// server action (rather than a client fetch) means the page stays a pure
// server boundary with no client-side bundle cost for plain form inputs.
//
// SM-2 (gate moat): super_admin only. The requireRole() helper redirects to
// /forbidden if the session role is anything else, so a programme_admin who
// somehow reaches this URL by typing it gets bounced.
//
// SM-4 (anti-download): the videoDefaultQuality dropdown only allows "480p".
// 720p and 1080p render as disabled options with a tooltip saying why (the
// worker's ladder tops out at 480p; spec 041 deferred 720p). Hardcoding the disable here means a future drive-by edit
// can't quietly enable them without also touching the zod allow-list.
//
// Copy is in the admin namespace (systemSettings.*), including each
// notification category's name and hint (systemSettings.notifications.kinds,
// keyed by NOTIFICATION_KIND_KEYS below). The values an administrator typed
// (programme name, academic year) are data.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { systemSettings, SYSTEM_SETTINGS_ID } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { lastAuditAt } from "@/admin/audit-lookups";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_KEYS, type NotificationKind } from "@/lib/notification-kinds";

export const dynamic = "force-dynamic";

// Same enums the route enforces — duplicated here for the zod parse on the action side.
const VIDEO_QUALITIES = ["480p"] as const;

// Each notification kind's message key (a kind has a dot in it, which a
// message key cannot). Typed on every kind, so a kind added to the catalogue
// without a name here fails the typecheck instead of rendering a raw key.
const NOTIFICATION_KIND_KEYS: Record<NotificationKind, string> = {
  "helpdesk.ticket": "helpdeskTicket",
  "cycle.assigned": "cycleAssigned",
  "cycle.complete": "cycleComplete",
  "video.transcoded": "videoTranscoded",
  "video.review_pending": "videoReviewPending",
  "meeting.scheduled": "meetingScheduled",
  "meeting.cancelled": "meetingCancelled",
  "pairing.final_submitted": "pairingFinalSubmitted",
  "digest.weekly": "digestWeekly",
};

// The fields a rejected save names in ?error= (comma-separated). Each has its
// own message, systemSettings.errors.<field>; the page used to echo zod's
// English issue text through the URL, which no translation could reach.
const SETTINGS_FIELDS = [
  "programmeName",
  "academicYear",
  "videoDefaultQuality",
  "videoMaxUploadMb",
  "notificationsEnabled",
  "backupRetentionDays",
] as const;

const ServerActionSchema = z.object({
  programmeName: z.string().min(1).max(200),
  academicYear: z
    .string()
    .min(1)
    .max(16)
    // i18n-ignore: zod issue text, kept in the audit row only; the page shows admin systemSettings.errors.academicYear
    .regex(/^\d{4}-\d{2}$/, "academicYear must be YYYY-YY"),
  videoDefaultQuality: z.enum(VIDEO_QUALITIES),
  videoMaxUploadMb: z.number().int().min(10).max(2000),
  notificationsEnabled: z.array(z.enum(NOTIFICATION_KEYS)),
  backupRetentionDays: z.number().int().min(7).max(365),
});

async function updateSystemSettings(formData: FormData) {
  "use server";
  // Re-gate inside the action — never trust the page-level gate alone, since
  // an attacker could replay the form-data against the action endpoint.
  await requireRole(["super_admin"]);

  const rawNotifications = formData.getAll("notificationsEnabled").map(String);
  const parsed = ServerActionSchema.safeParse({
    programmeName: String(formData.get("programmeName") ?? "").trim(),
    academicYear: String(formData.get("academicYear") ?? "").trim(),
    videoDefaultQuality: String(formData.get("videoDefaultQuality") ?? "480p"),
    videoMaxUploadMb: Number(formData.get("videoMaxUploadMb") ?? 500),
    notificationsEnabled: rawNotifications,
    backupRetentionDays: Number(formData.get("backupRetentionDays") ?? 14),
  });

  if (!parsed.success) {
    // TELL THE OPERATOR. This used to `return` silently.
    //
    // The comment here said server actions have no good error channel and that
    // the page "re-renders with the previous values" -- which it does, and that
    // is exactly the problem: a rejected save looked identical to a successful
    // one. Type 2026 instead of 2026-27, press Save, and the page comes back
    // with the old value and no message. The only trace was an audit row.
    // Anyone would conclude the setting had saved.
    //
    // A redirect back with a code is the error channel a plain <form action>
    // does have, and it is what the rest of this codebase already uses. The
    // code is the list of fields that were refused; the page says what each
    // one needs, in the operator's language. (It used to carry zod's English
    // issue text, which stayed English whatever language was chosen.) The
    // issues themselves go to the audit row.
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))]
      .filter((f) => (SETTINGS_FIELDS as readonly string[]).includes(f))
      .join(",");
    void recordAudit({
      action: "system_settings.update",
      entityType: "system_settings",
      entityId: SYSTEM_SETTINGS_ID,
      metadata: { error: "validation_failed", issues: parsed.error.issues },
    });
    redirect(`/admin/system-settings?error=${encodeURIComponent(fields || "invalid")}`);
  }

  await db
    .update(systemSettings)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID));

  void recordAudit({
    action: "system_settings.update",
    entityType: "system_settings",
    entityId: SYSTEM_SETTINGS_ID,
    metadata: { keys: Object.keys(parsed.data) },
  });

  // Refresh the SSR view so the operator sees the new values immediately.
  revalidatePath("/admin/system-settings");
}

export default async function SystemSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  // The reason a save was rejected, echoed back by updateSystemSettings. It
  // used to return silently and the page redisplayed the old value, so a
  // refused save was indistinguishable from an accepted one.
  const rawError = ((await searchParams) ?? {}).error;
  await requireRole(["super_admin"]);
  const t = await getTranslations("admin");
  let settingsError: string | null = null;
  if (typeof rawError === "string" && rawError !== "") {
    const named = rawError
      .split(",")
      .filter((f): f is (typeof SETTINGS_FIELDS)[number] => (SETTINGS_FIELDS as readonly string[]).includes(f));
    settingsError =
      named.length > 0
        ? [...new Set(named)].map((f) => t(`systemSettings.errors.${f}`)).join(" ")
        : t("systemSettings.errors.invalid");
  }

  // SM-1 view-side audit — record that an admin opened this surface. The query
  // below is plain SELECTs only, no PII.
  void recordAudit({
    action: "system_settings.surface_viewed",
    entityType: "system_settings",
    entityId: SYSTEM_SETTINGS_ID,
  });

  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID))
    .limit(1);

  // Status display — the latest backup.complete / restore.complete audit row,
  // one index probe each (admin/audit-lookups.ts), which backup.sh and
  // restore.sh append after each successful run. Where there is none yet (the
  // jobs have not run since they began writing it, or could not reach the
  // database) the panel says so and points at the host's own record
  // (last-backup.txt, workspace/last_restore_drill.json) -- it used to say
  // "never", which reads as "no backup has ever run" on a box whose nightly
  // backups pass.
  const lastBackupAt = await lastAuditAt("backup");
  const lastRestoreAt = await lastAuditAt("restore");

  const settings = row ?? {
    programmeName: "Goldenmile RTT",
    academicYear: "2026-27",
    videoDefaultQuality: "480p" as const,
    videoMaxUploadMb: 500,
    // The column default (packages/db/src/schema/systemSettings.ts): every
    // kind the application writes. A kind left out here is written and hidden.
    notificationsEnabled: [
      "cycle.assigned",
      "cycle.complete",
      "video.transcoded",
      "meeting.scheduled",
      "meeting.cancelled",
      "pairing.final_submitted",
      "helpdesk.ticket",
    ],
    backupRetentionDays: 14,
    updatedAt: null,
  };
  const enabledSet = new Set<string>(settings.notificationsEnabled ?? []);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      {settingsError ? (
        <div
          role="alert"
          data-testid="settings-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <strong className="font-semibold">{t("systemSettings.notSaved")}</strong> {settingsError}
        </div>
      ) : null}
      <header>
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("systemSettings.eyebrow")}
        </div>
        <h1 className="mt-1 font-serif text-2xl">{t("systemSettings.title")}</h1>
        <p className="mt-1 text-sm text-neutral-600">
          {t("systemSettings.intro")}
        </p>
      </header>

      <form action={updateSystemSettings} className="flex flex-col gap-8">
        {/* Section 1 — Programme */}
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="font-serif text-lg">{t("systemSettings.programme.heading")}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-500">{t("systemSettings.programme.name")}</span>
              <input
                type="text"
                name="programmeName"
                defaultValue={settings.programmeName}
                maxLength={200}
                required
                className="rounded border border-neutral-300 px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-500">{t("systemSettings.programme.academicYear")}</span>
              <input
                type="text"
                name="academicYear"
                defaultValue={settings.academicYear}
                pattern="\d{4}-\d{2}"
                title={t("systemSettings.programme.academicYearHint")}
                required
                className="rounded border border-neutral-300 px-2 py-1 font-mono"
              />
            </label>
          </div>
        </section>

        {/* Section 2 — Video pipeline */}
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="font-serif text-lg">{t("systemSettings.video.heading")}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-500">{t("systemSettings.video.defaultQuality")}</span>
              <select
                name="videoDefaultQuality"
                defaultValue={settings.videoDefaultQuality}
                className="rounded border border-neutral-300 px-2 py-1"
              >
                <option value="480p">{t("systemSettings.video.q480")}</option>
                <option value="720p" disabled title={t("systemSettings.video.q720Title")}>
                  {t("systemSettings.video.q720")}
                </option>
                <option value="1080p" disabled title={t("systemSettings.video.q1080Title")}>
                  {t("systemSettings.video.q1080")}
                </option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-500">{t("systemSettings.video.maxUpload")}</span>
              <input
                type="number"
                name="videoMaxUploadMb"
                defaultValue={settings.videoMaxUploadMb}
                min={10}
                max={2000}
                step={10}
                required
                className="rounded border border-neutral-300 px-2 py-1 font-mono"
              />
            </label>
          </div>
        </section>

        {/* Section 3 — Notifications */}
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="font-serif text-lg">{t("systemSettings.notifications.heading")}</h2>
          <p className="text-xs text-neutral-500">
            {t("systemSettings.notifications.intro")}
          </p>
          <ul className="grid grid-cols-1 gap-2">
            {NOTIFICATION_CATEGORIES.map((cat) => (
              <li key={cat.key} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id={`notif-${cat.key}`}
                  name="notificationsEnabled"
                  value={cat.key}
                  defaultChecked={enabledSet.has(cat.key)}
                  className="mt-1"
                />
                <label htmlFor={`notif-${cat.key}`} className="flex flex-col text-sm">
                  <span className="font-medium">
                    {t(`systemSettings.notifications.kinds.${NOTIFICATION_KIND_KEYS[cat.key]}.label`)}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {t(`systemSettings.notifications.kinds.${NOTIFICATION_KIND_KEYS[cat.key]}.hint`)}
                  </span>
                  <code className="font-mono text-[10px] text-neutral-400">{cat.key}</code>
                </label>
              </li>
            ))}
          </ul>
        </section>

        {/* Section 4 — Backups & retention */}
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="font-serif text-lg">{t("systemSettings.backups.heading")}</h2>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-500">{t("systemSettings.backups.retention")}</span>
            <input
              type="number"
              name="backupRetentionDays"
              defaultValue={settings.backupRetentionDays}
              min={7}
              max={365}
              step={1}
              required
              className="w-40 rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <p className="text-xs text-neutral-500">
            {t.rich("systemSettings.backups.retentionHelp", {
              strong: (chunks) => <strong>{chunks}</strong>,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        </section>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700"
          >
            {t("systemSettings.save")}
          </button>
          <span className="text-xs text-neutral-500">
            {t.rich("systemSettings.lastUpdated", {
              when: settings.updatedAt
                ? new Date(settings.updatedAt).toISOString().slice(0, 16).replace("T", " ")
                : "—",
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </span>
        </div>
      </form>

      {/* Section 5 — Status display (read-only) */}
      <section
        data-system-status
        className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
      >
        <h2 className="font-serif text-lg">{t("systemSettings.status.heading")}</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
              {t("systemSettings.status.lastBackup")}
            </dt>
            <dd className="font-mono">
              {lastBackupAt
                ? lastBackupAt.toISOString().slice(0, 16).replace("T", " ")
                : t("systemSettings.status.backupNotReported")}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
              {t("systemSettings.status.lastRestoreDrill")}
            </dt>
            <dd className="font-mono">
              {lastRestoreAt
                ? lastRestoreAt.toISOString().slice(0, 16).replace("T", " ")
                : t("systemSettings.status.restoreNotReported")}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-neutral-500">
          {t.rich("systemSettings.status.sources", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </section>
    </main>
  );
}
