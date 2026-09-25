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
// for a mentee's quarterly video) from the cycle and pairing pages, runs the
// reservation's own check on it (./context.ts), and says what the upload is
// for. Without one it asks, offering the user's own open cycles, meetings and
// quarterly videos -- and "something else", knowingly.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { actorFrom } from "@/lib/authz";
import { db } from "@gml/db";
import { videoSubmissions, files, observationCycles } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";
import { MobileUploadRunner } from "@/components/video/MobileUploadRunner";
import { getDeviceType } from "@/lib/device";
import { assertEnv } from "@/lib/env";
import { uploadLimitBytes } from "@/lib/video/upload";
import { attachUploadAction } from "./actions";
import {
  assertContextAllowed,
  describeUploadTarget,
  encodeTarget,
  openUploadContexts,
  uploadHref,
  type GatedSection,
  type TargetDescription,
  type UploadTarget,
} from "./context";

export const dynamic = "force-dynamic";

// Reused from /videos/page.tsx (spec 067) so the visual language is identical.
const STATE_LABEL: Record<string, string> = {
  received: "received",
  queued: "queued",
  transcoding: "transcoding",
  ready: "ready",
  failed: "failed",
  review_pending: "review pending",
  reviewed: "reviewed",
};

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

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  direct: "Web",
  external_link: "External",
};

const SOURCE_CHIP: Record<string, string> = {
  whatsapp: "chip-lichen",
  direct: "chip-indigo",
  external_link: "",
};

// Human label for context_type rows that don't surface a code.
const CONTEXT_LABEL: Record<string, string> = {
  teach_back: "Teach-back",
  mentor_meeting: "Mentor meeting",
  mentee_quarterly: "Mentee quarterly",
  classroom_session: "Classroom session",
  // Said plainly: a generic video is the one the observer and mentor cannot see.
  generic: "Not linked (only you and admins)",
};

const SECTION_NAME: Record<GatedSection, string> = { observation: "Observation", mentorship: "Mentorship" };

/** What attachUploadAction redirected back with. Unknown codes show nothing. */
const ATTACH_NOTICE: Record<string, { text: string; ok: boolean }> = {
  done: { text: "Attached. The video now shows where you chose.", ok: true },
  invalid: { text: "Choose what to attach the video to.", ok: false },
  refused: { text: "The video could not be attached there. Choose another place.", ok: false },
  not_attachable: { text: "Only your own videos that are not linked yet can be attached.", ok: false },
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
function explainerCards(whatsappPhone: string | null, whatsappText: string | null, chosen: boolean, maxMb: number) {
  const dialable = whatsappPhone ? whatsappPhone.replace(/[^0-9]/g, "") : null;
  const exact = whatsappText !== null && whatsappText !== "OBS-";
  return [
    ...(whatsappPhone && dialable && whatsappText !== null
      ? [
          {
            icon: "wa",
            title: "Forward via WhatsApp",
            desc: exact
              ? `Send your video to ${whatsappPhone} with the caption ${whatsappText}. Fastest on 2G/3G.`
              : `Send your video to ${whatsappPhone} with your cycle code as the caption, e.g. OBS-2026-009. Fastest on 2G/3G.`,
            accent: "var(--lichen)",
            primary: true,
            cta: "Open WhatsApp",
            href: `https://wa.me/${dialable}?text=${encodeURIComponent(whatsappText)}`,
          },
        ]
      : []),
    {
      icon: "up",
      title: "Upload here",
      // The limit beginUpload enforces (uploadLimitBytes), not a literal.
      desc: `Choose a file below. Resumes on disconnect. Max file ${maxMb} MB. We'll transcode to HLS automatically.`,
      accent: "var(--indigo)",
      primary: false,
      cta: "Start",
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

  // WHAT THIS UPLOAD IS FOR, from the link that brought the user here. The
  // same check the reservation runs (a target this user may not see is a 404,
  // like the cycle or pairing page itself); then its section's gate, since the
  // names shown are that section's data.
  let target: (UploadTarget & { description: TargetDescription }) | null = null;
  let refusal: string | null = null;
  let locked: { section: GatedSection; back: string } | null = null;
  if (sp.context) {
    const check = await assertContextAllowed(actor, {
      contextType: sp.context,
      contextId: sp.contextId ?? null,
      quarter: sp.quarter ? Number(sp.quarter) : null,
    });
    if (!check.ok) {
      refusal = check.error;
    } else {
      const d = await describeUploadTarget(actor, check.target);
      if (d.locked) locked = { section: d.locked, back: uploadHref(check.target) };
      else target = { ...check.target, description: d.description };
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
  // Spec 135 — device-aware shell. The same env-var contract as
  // /videos UploadModal (spec 132) is reused for the WhatsApp fallback.
  // Spec 169 — `process.env.GML_WHATSAPP_NUMBER` is now read THROUGH
  // assertEnv() so a typo'd value (missing `+`, stray whitespace) falls
  // through to `WHATSAPP_PHONE_NUMBER_ID` / null and the downstream
  // UploadModal / MobileUploadRunner hide the WhatsApp path entirely
  // rather than rendering a broken wa.me link. The legacy env name is
  // preserved for backwards compatibility with deployments that pre-date
  // the GML_* override.
  const device = await getDeviceType();
  // See videos/page.tsx: WHATSAPP_PHONE_NUMBER_ID is Meta's opaque account id,
  // not a dialable number, and must never be used as a fallback here.
  const whatsappPhone = assertEnv().whatsappNumber.value ?? null;
  const maxMb = Math.floor((await uploadLimitBytes()) / (1024 * 1024));
  const cards = explainerCards(whatsappPhone, whatsappText, target !== null, maxMb);

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
  // cycles, meetings and quarterly slots the chooser offers.
  const attachOptions = rows.some((r) => r.contextType === "generic")
    ? (choices ?? (await openUploadContexts(actor))).options.map((o) => ({ value: encodeTarget(o.target), title: `${o.title} · ${o.detail}` }))
    : [];
  const attachNotice = sp.attach ? (ATTACH_NOTICE[sp.attach] ?? null) : null;

  return (
    <div>
      <div className="page-header">
        <div className="label">
          My uploads ·{" "}
          <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)" }}>
            मेरे अपलोड
          </span>
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          Submit a lesson video
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Send it over WhatsApp or upload it here — whichever works on your network today.
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
              <div className="label">This video is for</div>
              <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginTop: 4 }}>
                {target.description.title}
              </div>
              <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
                {target.description.audience}
              </p>
              {sp.context ? (
                <Link href="/uploads" style={{ fontSize: 12, color: "var(--indigo)" }}>
                  Choose something else
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
                  That link is for the {SECTION_NAME[locked.section]} section.{" "}
                  <a href={`/gate/${locked.section}?next=${encodeURIComponent(locked.back)}`}>
                    Unlock {SECTION_NAME[locked.section]}
                  </a>{" "}
                  to upload to it.
                </p>
              ) : null}
              <div className="label">What is this video for?</div>
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
                      Unlock {SECTION_NAME[s]} to choose {s === "observation" ? "a cycle" : "a meeting or a quarterly video"}
                    </a>
                  </li>
                ))}
                <li>
                  <Link href="/uploads?context=generic" className="btn btn-ghost" style={{ textDecoration: "none" }}>
                    Something else
                  </Link>
                  <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
                    Linked to nothing: only you and programme administrators will see it.
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
            <div style={{ fontWeight: 600, fontSize: 14 }}>On a slow 2G/3G link?</div>
            <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>
              Send the video to {whatsappPhone} on WhatsApp with your cycle code as the caption, e.g. OBS-2026-009.
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
              Open WhatsApp
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
                  key={c.title}
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
                    {c.icon}
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
            <div style={{ fontWeight: 600 }}>My recent uploads</div>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {rows.length} {rows.length === 1 ? "video" : "videos"} · most
              recent first
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
                You haven&apos;t uploaded anything yet.
              </div>
              <div style={{ fontSize: 12 }}>
                Use one of the options above — WhatsApp is the fastest on
                a flaky connection.
              </div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    {[
                      "File",
                      "Source",
                      "Linked to",
                      "Size",
                      "State",
                      "Date",
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isReady = r.status === "ready";
                    const filename = r.filename ?? "(unnamed)";
                    const isPdf = r.mimeType?.startsWith("application/pdf");
                    const linkedTo =
                      r.contextType === "observation_cycle"
                        ? (r.cycleCode ?? "—")
                        : r.contextType === "mentee_quarterly" && r.contextQuarter
                          ? `${CONTEXT_LABEL.mentee_quarterly} · Q${r.contextQuarter}`
                          : (CONTEXT_LABEL[r.contextType] ?? "—");
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
                              width: 18,
                              marginRight: 6,
                              color: "var(--ink-3)",
                              fontSize: 10,
                            }}
                          >
                            {isPdf ? "PDF" : "VID"}
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
                            {SOURCE_LABEL[r.source] ?? r.source}
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
                          {r.contextType === "generic" && attachOptions.length > 0 ? (
                            <form action={attachUploadAction} style={{ display: "flex", gap: 4, marginTop: 4 }}>
                              <input type="hidden" name="submissionId" value={r.id} />
                              <select
                                name="target"
                                defaultValue=""
                                required
                                aria-label={`Attach ${filename} to`}
                                style={{ fontSize: 11, maxWidth: 220 }}
                              >
                                <option value="" disabled>
                                  Attach to…
                                </option>
                                {attachOptions.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.title}
                                  </option>
                                ))}
                              </select>
                              <button type="submit" className="btn btn-sm" style={{ fontSize: 11 }}>
                                Attach
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
                            {STATE_LABEL[r.status] ?? r.status}
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
