// /uploads — teacher's "My uploads" personal landing.
// 1:1 port of `LMS GML Frontend/forms.jsx::UploadsPage` (lines 342-375).
// - Explainer cards (WhatsApp PRIMARY / browser upload). A third, "Record
//   in-app", promised "Saves to your phone first; uploads when you have wifi"
//   and linked to the same file picker: nothing records, saves offline or
//   waits for wifi on a desktop, so it is gone (F13). Recording is the phone
//   flow's "Record now".
// - Inline <UploadProgress /> tray (spec 045) for browser uploads
// - Table of viewer's own video_submissions (most recent 50), joined with files
//   for the original filename and with observation_cycles for the linked cycle code.
//
// Spec 135 (Workflow Run 12 final frontend-parity): on mobile we swap the
// explainer cards + UploadProgress tray for the dedicated MobileUploadRunner
// flow (full-screen Record / Pick → Preview → Upload progress). Desktop keeps
// its explainer cards and tray. The recent-uploads table is
// rendered on both shells because viewing past submissions is identical work
// regardless of device.
//
// WHAT THE VIDEO IS FOR. Every upload here used to be 'generic' -- the desktop
// tray was hard-wired to that context and the phone flow sent the same --
// although the teacher's dashboard to-do "Upload lesson video for 1 cycle"
// links here. A generic video is visible to its uploader and administrators
// only, so her observer and mentor got a 404 and the cycle's Evidence card
// stayed empty (F18). The page now takes ?context=&contextId= (and &quarter=
// for a mentee's quarterly video) from the cycle, pairing and RTT subject
// pages, runs the reservation's own check on it (./context.ts), and says what
// the upload is for. Without one it asks, offering the user's own open cycles,
// meetings, quarterly videos and teach-backs -- and "something else",
// knowingly.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { normalizeLocale } from "@/i18n/config";
import { statusLabel, type VideoTranslate } from "@/lib/video/labels";
import { actorFrom } from "@/lib/authz";
import { db } from "@gml/db";
import { videoSubmissions, files, observationCycles } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";
import { MobileUploadRunner } from "@/components/video/MobileUploadRunner";
import { getDeviceType } from "@/lib/device";
import { whatsappPhoneForUsers } from "@/lib/env";
import { uploadLimitBytes } from "@/lib/video/upload";
import { attachUploadAction } from "./actions";
import {
  assertContextAllowed,
  describeUploadTarget,
  encodeTarget,
  lockedSection,
  openUploadContexts,
  uploadHref,
  type GatedSection,
  type TargetDescription,
  type UploadTarget,
} from "./context";

export const dynamic = "force-dynamic";

// Status labels are shared with /videos/page.tsx (spec 067) so the visual
// language is identical: lib/video/labels.ts, video.status.* in the bundles.

// Maps video_submissions.status -> chip variant class (matches data.jsx STATUS_CHIPS).
const STATE_CHIP: Record<string, string> = {
  ready: "chip-lichen",
  transcoding: "chip-saffron",
  queued: "",
  received: "",
  failed: "chip-rust",
  review_pending: "chip-saffron",
  reviewed: "chip-indigo",
};

/** Sources with a label of their own (video.uploads.source.*); others show as stored. */
const SOURCE_LABELLED: ReadonlySet<string> = new Set(["whatsapp", "direct", "external_link"]);

const SOURCE_CHIP: Record<string, string> = {
  whatsapp: "chip-lichen",
  direct: "chip-indigo",
  external_link: "",
};

// Human label for context_type rows that don't surface a code
// (video.uploads.linked.*). Said plainly for generic: a generic video is the
// one the observer and mentor cannot see.
const CONTEXT_LABELLED: ReadonlySet<string> = new Set([
  "teach_back",
  "mentor_meeting",
  "mentee_quarterly",
  "classroom_session",
  "generic",
]);

/**
 * What attachUploadAction redirected back with (video.uploads.attachNotice.*).
 * Unknown codes show nothing.
 */
const ATTACH_NOTICE: Record<string, { ok: boolean }> = {
  done: { ok: true },
  invalid: { ok: false },
  refused: { ok: false },
  not_attachable: { ok: false },
  locked: { ok: false },
};

/**
 * Built per request, because these cards were lying about the product.
 *
 *   WhatsApp   The number and the wa.me link were HARDCODED to
 *              +91 90600 22013, three lines above the same file's own
 *              env-driven `whatsappPhone`. Any deployment with a different
 *              programme number -- which is every deployment but the one this
 *              was typed on -- sent teachers to a stranger. When no number is
 *              configured the card is dropped entirely rather than shown with
 *              a dead link.
 *
 *   Drag       "Drag a file to this card" described a feature that does not
 *              exist: neither the card nor UploadProgress implements a single
 *              drag or drop handler, so a dropped video made the browser
 *              navigate away from the page and open the file instead, losing
 *              whatever was in progress. The copy now describes the button
 *              that is actually there.
 *
 *   Size       "Max file 500 MB" was a literal, while the cap beginUpload
 *              enforces is the programme setting (10 to 2000 MB). It is now
 *              the same number (uploadLimitBytes).
 *
 * `whatsappText` is the caption that sends a video to the same place as this
 * page's upload: the chosen cycle's code or meeting's MM- code, "OBS-" for the
 * teacher to finish when nothing is chosen, and null when WhatsApp cannot reach
 * the target at all -- then the card is dropped, because the video would
 * arrive linked to nothing.
 */
function explainerCards(whatsappPhone: string | null, whatsappText: string | null, chosen: boolean, maxMb: number, t: VideoTranslate) {
  const dialable = whatsappPhone ? whatsappPhone.replace(/[^0-9]/g, "") : null;
  const exact = whatsappText !== null && whatsappText !== "OBS-";
  return [
    ...(whatsappPhone && dialable && whatsappText !== null
      ? [
          {
            icon: "wa",
            glyph: t("uploads.cards.whatsappGlyph"),
            title: t("uploads.cards.whatsappTitle"),
            desc: exact
              ? t("uploads.cards.whatsappExact", { phone: whatsappPhone, caption: whatsappText })
              : t("uploads.cards.whatsappCode", { phone: whatsappPhone }),
            accent: "var(--lichen)",
            primary: true,
            cta: t("uploads.openWhatsapp"),
            href: `https://wa.me/${dialable}?text=${encodeURIComponent(whatsappText)}`,
          },
        ]
      : []),
    {
      icon: "up",
      glyph: t("uploads.cards.uploadGlyph"),
      title: t("uploads.cards.uploadTitle"),
      // The limit beginUpload enforces (uploadLimitBytes), not a literal.
      desc: t("uploads.cards.uploadBody", { maxMb }),
      accent: "var(--indigo)",
      primary: false,
      cta: t("uploads.cards.start"),
      // Until the page knows what the video is for, there is no tray to go to.
      href: chosen ? "#upload-tray" : "#upload-target",
    },
  ];
}

function humanSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatIST(d: Date | null): string {
  if (!d) return "—";
  // YYYY-MM-DD HH:MM in Asia/Kolkata, monospace-friendly.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export default async function UploadsPage({
  searchParams,
}: {
  searchParams?: Promise<{ context?: string; contextId?: string; quarter?: string; attach?: string }>;
} = {}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/forbidden");
  }
  const actor = actorFrom(session);
  if (!actor) redirect("/forbidden");
  const viewerId = session.user.id;
  const sp = (await searchParams) ?? {};
  const t = await getTranslations("video");
  const locale = normalizeLocale(await getLocale());

  // WHAT THIS UPLOAD IS FOR, from the link that brought the user here. First
  // its section's gate, since everything said about the target -- its name, a
  // refusal such as "This cycle has been signed off", even a 404 rather than an
  // "unlock" -- is that section's data. Then the same check the reservation
  // runs (a target this user may not see is a 404, like the cycle or pairing
  // page itself).
  let target: (UploadTarget & { description: TargetDescription }) | null = null;
  let refusal: string | null = null;
  let locked: { section: GatedSection; back: string } | null = null;
  if (sp.context) {
    const asked = { contextType: sp.context, contextId: sp.contextId ?? null, quarter: sp.quarter ? Number(sp.quarter) : null };
    const gate = await lockedSection(actor, asked.contextType);
    if (gate) {
      locked = { section: gate, back: uploadHref(asked) };
    } else {
      const check = await assertContextAllowed(actor, asked);
      if (!check.ok) {
        refusal = check.error;
      } else {
        const d = await describeUploadTarget(actor, check.target);
        if (d.locked) locked = { section: d.locked, back: uploadHref(check.target) };
        else target = { ...check.target, description: d.description };
      }
    }
  }
  // Without a target: the user's own open cycles, meetings and quarterly
  // videos to choose from. With none, and nothing locked, there is nothing to
  // choose -- the upload is simply not linked to anything, and says so.
  const choices = target ? null : await openUploadContexts(actor);
  if (!target && !refusal && !locked && choices && choices.options.length === 0 && choices.locked.length === 0) {
    const generic: UploadTarget = { contextType: "generic", contextId: null, quarter: null };
    const d = await describeUploadTarget(actor, generic);
    if (!d.locked) target = { ...generic, description: d.description };
  }
  const whatsappText = target ? target.description.whatsappText : "OBS-";
  // Spec 135 — device-aware shell. The WhatsApp number is null while
  // WhatsApp ingest is off or GML_WHATSAPP_NUMBER is invalid (lib/env.ts
  // whatsappPhoneForUsers), and the cards and MobileUploadRunner then offer
  // no WhatsApp path at all rather than a link to a channel that drops the
  // video. WHATSAPP_PHONE_NUMBER_ID is Meta's opaque account id, not a
  // dialable number, and is never a fallback (see videos/page.tsx).
  const device = await getDeviceType();
  const whatsappPhone = whatsappPhoneForUsers();
  const maxMb = Math.floor((await uploadLimitBytes()) / (1024 * 1024));
  const cards = explainerCards(whatsappPhone, whatsappText, target !== null, maxMb, t);

  const rows = await db
    .select({
      id: videoSubmissions.id,
      source: videoSubmissions.source,
      status: videoSubmissions.status,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      createdAt: videoSubmissions.createdAt,
      durationSec: videoSubmissions.durationSec,
      filename: files.originalFilename,
      sizeBytes: files.sizeBytes,
      mimeType: files.mimeType,
      contextQuarter: videoSubmissions.contextQuarter,
      cycleCode: observationCycles.code,
    })
    .from(videoSubmissions)
    .leftJoin(files, eq(videoSubmissions.fileId, files.id))
    .leftJoin(
      observationCycles,
      and(
        eq(videoSubmissions.contextType, "observation_cycle"),
        eq(videoSubmissions.contextId, observationCycles.id),
      ),
    )
    .where(eq(videoSubmissions.submittedByUserId, viewerId))
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(50);

  // What an unlinked video of hers can still be attached to: the same open
  // cycles, meetings, quarterly slots and teach-backs the chooser offers. Not
  // a failed one (attachSubmissionToContext refuses it): its bytes never came,
  // or it will not play. One still uploading can be: its completion links the
  // row's context as it is then.
  const attachable = (r: { contextType: string; status: string }) => r.contextType === "generic" && r.status !== "failed";
  const attachOptions = rows.some(attachable)
    ? (choices ?? (await openUploadContexts(actor))).options.map((o) => ({ value: encodeTarget(o.target), title: `${o.title} · ${o.detail}` }))
    : [];
  const attachCode = sp.attach && Object.hasOwn(ATTACH_NOTICE, sp.attach) ? sp.attach : null;
  const attachNotice = attachCode ? { text: t(`uploads.attachNotice.${attachCode}`), ok: ATTACH_NOTICE[attachCode]!.ok } : null;
  const sectionName = (s: GatedSection) => t(`uploads.section.${s}`);
  const linkedLabel = (contextType: string) => (CONTEXT_LABELLED.has(contextType) ? t(`uploads.linked.${contextType}`) : "—");

  return (
    <div>
      <div className="page-header">
        <div className="label">
          {t("uploads.label")}
          {/* The Hindi name beside the English one (SM-7). In Hindi or Bhoti
              the label above is already in the reader's language. */}
          {locale === "en" ? (
            <>
              {" · "}
              <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)" }}>
                मेरे अपलोड
              </span>
            </>
          ) : null}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          {t("uploads.title")}
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {t("uploads.intro")}
        </p>
      </div>

      <div className="page-body">
        {attachNotice ? (
          <p
            role={attachNotice.ok ? "status" : "alert"}
            style={{ fontSize: 13, margin: "0 0 12px", color: attachNotice.ok ? "var(--ink-2)" : "var(--rust)" }}
          >
            {attachNotice.text}
          </p>
        ) : null}
        <section
          id="upload-target"
          data-testid="upload-target"
          className="card"
          style={{ padding: 18, marginBottom: 18 }}
        >
          {target ? (
            <>
              <div className="label">{t("uploads.target.label")}</div>
              <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginTop: 4 }}>
                {target.description.title}
              </div>
              <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
                {target.description.audience}
              </p>
              {sp.context ? (
                <Link href="/uploads" style={{ fontSize: 12, color: "var(--indigo)" }}>
                  {t("uploads.target.change")}
                </Link>
              ) : null}
            </>
          ) : (
            <>
              {refusal ? (
                <p role="alert" style={{ color: "var(--rust)", fontSize: 13, margin: "0 0 10px" }}>
                  {refusal}
                </p>
              ) : null}
              {locked ? (
                <p style={{ fontSize: 13, margin: "0 0 10px" }}>
                  {t.rich("uploads.locked", {
                    section: sectionName(locked.section),
                    link: (chunks) => (
                      <a href={`/gate/${locked!.section}?next=${encodeURIComponent(locked!.back)}`}>{chunks}</a>
                    ),
                  })}
                </p>
              ) : null}
              <div className="label">{t("uploads.choose.label")}</div>
              <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 8 }}>
                {(choices?.options ?? []).map((o) => (
                  <li key={o.href}>
                    <Link href={o.href} className="btn" style={{ textDecoration: "none", minHeight: 44 }}>
                      {o.title}
                    </Link>
                    <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>{o.detail}</span>
                  </li>
                ))}
                {(choices?.locked ?? []).map((s) => (
                  <li key={s}>
                    <a
                      href={`/gate/${s}?next=${encodeURIComponent("/uploads")}`}
                      className="btn btn-ghost"
                      style={{ textDecoration: "none" }}
                    >
                      {t(`uploads.choose.unlock.${s}`)}
                    </a>
                  </li>
                ))}
                <li>
                  <Link href="/uploads?context=generic" className="btn btn-ghost" style={{ textDecoration: "none" }}>
                    {t("uploads.choose.other")}
                  </Link>
                  <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
                    {t("uploads.choose.otherHint")}
                  </span>
                </li>
              </ul>
            </>
          )}
        </section>

        {/* On a phone the WhatsApp route lives inside the upload flow, which
            is shown once the page knows what the video is for. Until then it
            is offered here, as the desktop card offers it. */}
        {device === "mobile" && !target && whatsappPhone && whatsappText !== null ? (
          <section
            style={{
              marginBottom: 18,
              padding: 14,
              borderRadius: 12,
              background: "var(--lichen-soft)",
              border: "1px solid oklch(0.82 0.06 145)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t("uploads.slowLink.title")}</div>
            <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>
              {t("uploads.slowLink.body", { phone: whatsappPhone })}
            </p>
            <a
              href={`https://wa.me/${whatsappPhone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(whatsappText)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block",
                marginTop: 10,
                minHeight: 44,
                padding: "10px 16px",
                borderRadius: 10,
                background: "var(--lichen)",
                color: "white",
                fontWeight: 500,
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              {t("uploads.openWhatsapp")}
            </a>
          </section>
        ) : null}

        {device === "mobile" && target ? (
          <section style={{ marginBottom: 22 }}>
            <MobileUploadRunner
              whatsappPhone={whatsappPhone}
              target={{
                contextType: target.contextType,
                contextId: target.contextId,
                quarter: target.quarter,
                whatsappText: target.description.whatsappText,
              }}
            />
          </section>
        ) : null}

        {device === "desktop" ? (
          <>
            <section
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${cards.length}, 1fr)`,
                gap: 14,
                marginBottom: 18,
              }}
            >
              {cards.map((c) => (
                <article
                  key={c.icon}
                  className={`card${c.primary ? " card-hi" : ""}`}
                  style={{
                    padding: 22,
                    border: c.primary ? "2px solid var(--ink)" : undefined,
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 10,
                      background: c.accent,
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                    }}
                    aria-hidden
                  >
                    {c.glyph}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--serif)",
                      fontSize: 18,
                      marginTop: 12,
                    }}
                  >
                    {c.title}
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--ink-3)",
                      marginTop: 6,
                      lineHeight: 1.5,
                    }}
                  >
                    {c.desc}
                  </p>
                  <a
                    href={c.href}
                    target={c.primary ? "_blank" : undefined}
                    rel={c.primary ? "noopener noreferrer" : undefined}
                    className={`btn${c.primary ? " btn-primary" : ""}`}
                    style={{
                      marginTop: 12,
                      alignSelf: "flex-start",
                      textDecoration: "none",
                    }}
                  >
                    {c.cta}
                  </a>
                </article>
              ))}
            </section>

            {target ? (
              <section id="upload-tray" style={{ marginBottom: 22 }}>
                <UploadProgress
                  contextType={target.contextType}
                  contextId={target.contextId ?? undefined}
                  quarter={target.quarter}
                />
              </section>
            ) : null}
          </>
        ) : null}

        <div className="card" style={{ padding: 22 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 600 }}>{t("uploads.recent.title")}</div>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {t("uploads.recent.count", { count: rows.length })}
            </span>
          </div>

          {rows.length === 0 ? (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 13,
                border: "1px dashed var(--line)",
                borderRadius: "var(--r-2)",
                background: "var(--paper)",
              }}
            >
              <div
                style={{
                  fontWeight: 500,
                  color: "var(--ink-2)",
                  marginBottom: 4,
                }}
              >
                {t("uploads.recent.empty")}
              </div>
              <div style={{ fontSize: 12 }}>
                {t("uploads.recent.emptyHint")}
              </div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    {(["file", "source", "linked", "size", "state", "date"] as const).map((h) => (
                      <th key={h}>{t(`uploads.recent.col.${h}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isReady = r.status === "ready";
                    const filename = r.filename ?? t("uploads.recent.unnamed");
                    const isPdf = r.mimeType?.startsWith("application/pdf");
                    const linkedTo =
                      r.contextType === "observation_cycle"
                        ? (r.cycleCode ?? "—")
                        : r.contextType === "mentee_quarterly" && r.contextQuarter
                          ? t("uploads.linked.menteeQuarter", { quarter: r.contextQuarter })
                          : linkedLabel(r.contextType);
                    const sourceChipCls = SOURCE_CHIP[r.source] ?? "";
                    const stateChipCls = STATE_CHIP[r.status] ?? "";
                    return (
                      <tr key={r.id}>
                        <td>
                          <span
                            aria-hidden
                            className="mono"
                            style={{
                              display: "inline-block",
                              // At least as wide as "VID"; a translated tag may be wider.
                              minWidth: 18,
                              marginRight: 6,
                              color: "var(--ink-3)",
                              fontSize: 10,
                            }}
                          >
                            {isPdf ? "PDF" : t("uploads.recent.videoTag")}
                          </span>
                          {isReady ? (
                            <Link
                              href={`/videos/${r.id}`}
                              style={{
                                color: "var(--ink)",
                                textDecoration: "none",
                                borderBottom: "1px solid var(--line-2)",
                              }}
                            >
                              {filename}
                            </Link>
                          ) : (
                            <span style={{ color: "var(--ink-2)" }}>
                              {filename}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`chip ${sourceChipCls}`.trim()}>
                            {SOURCE_LABELLED.has(r.source) ? t(`uploads.source.${r.source}`) : r.source}
                          </span>
                        </td>
                        <td
                          className={
                            r.contextType === "observation_cycle"
                              ? "mono"
                              : undefined
                          }
                          style={{ color: "var(--ink-2)" }}
                        >
                          {linkedTo}
                          {/* An unlinked video can still be put where it
                              belongs, instead of sent again (attachUploadAction). */}
                          {attachable(r) && attachOptions.length > 0 ? (
                            <form action={attachUploadAction} style={{ display: "flex", gap: 4, marginTop: 4 }}>
                              <input type="hidden" name="submissionId" value={r.id} />
                              <select
                                name="target"
                                defaultValue=""
                                required
                                aria-label={t("uploads.attach.label", { filename })}
                                style={{ fontSize: 11, maxWidth: 220 }}
                              >
                                <option value="" disabled>
                                  {t("uploads.attach.placeholder")}
                                </option>
                                {attachOptions.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.title}
                                  </option>
                                ))}
                              </select>
                              <button type="submit" className="btn btn-sm" style={{ fontSize: 11 }}>
                                {t("uploads.attach.submit")}
                              </button>
                            </form>
                          ) : null}
                        </td>
                        <td
                          className="mono"
                          style={{ fontSize: 11, color: "var(--ink-3)" }}
                        >
                          {humanSize(r.sizeBytes)}
                        </td>
                        <td>
                          <span className={`chip ${stateChipCls}`.trim()}>
                            {statusLabel(t, r.status)}
                          </span>
                        </td>
                        <td
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: "var(--ink-3)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatIST(r.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
