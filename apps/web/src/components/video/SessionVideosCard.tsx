// The Videos card of a classroom session or class page: the clips attached to
// it, and the way to add one. A server component; copy is video.sessionVideos.*
//
// Upload is a plain link (a session page) or a plain GET form (a class page,
// which picks the session) to /uploads, which does the rest: the same
// reservation and resumable upload every other context uses.

import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import type { SessionVideo } from "@/lib/video/session-videos";
import { isVideoProcessing } from "@/lib/video/labels";
import { RefreshWhileProcessing } from "./RefreshWhileProcessing";

export type UploadChoice =
  /** A session page: one button for this session. */
  | { kind: "session"; sessionId: string }
  /** A class page: pick one of these sessions, then go. */
  | { kind: "pick"; sessions: Array<{ id: string; label: string }> };

export async function SessionVideosCard({
  videos,
  upload,
  showSession = false,
}: {
  videos: SessionVideo[];
  /** Absent when the viewer may look but not upload. */
  upload?: UploadChoice | null;
  /** Name the session each clip belongs to (a class page lists several). */
  showSession?: boolean;
}) {
  const t = await getTranslations("video");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const day = (d: Date | string) =>
    (typeof d === "string" ? new Date(`${d}T00:00:00+05:30`) : d).toLocaleDateString(intl, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });

  return (
    <section className="card card-hi" style={{ minWidth: 0 }} data-testid="session-videos">
      {/* A video still processing: keep its status current without a reload. */}
      <RefreshWhileProcessing active={videos.some((v) => isVideoProcessing(v.status))} />
      <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
        <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
          {t("sessionVideos.title")}
        </h2>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{t("sessionVideos.sub")}</div>
      </header>
      <div style={{ padding: 14, display: "grid", gap: 12, minWidth: 0 }}>
        {upload?.kind === "session" ? (
          <div>
            <Link
              href={`/uploads?context=classroom_session&contextId=${upload.sessionId}`}
              className="btn btn-primary"
              data-testid="session-video-upload"
            >
              {t("sessionVideos.upload")}
            </Link>
          </div>
        ) : null}

        {upload?.kind === "pick" ? (
          upload.sessions.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>{t("sessionVideos.noSessions")}</p>
          ) : (
            <form
              action="/uploads"
              method="get"
              style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}
              data-testid="session-video-upload-form"
            >
              <input type="hidden" name="context" value="classroom_session" />
              <label style={{ display: "grid", gap: 4, minWidth: 0, flex: "1 1 220px" }}>
                <span className="label">{t("sessionVideos.pick")}</span>
                <select name="contextId" className="input" defaultValue={upload.sessions[0]!.id} style={{ width: "100%", minWidth: 0 }}>
                  {upload.sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="btn btn-primary">
                {t("sessionVideos.upload")}
              </button>
            </form>
          )
        ) : null}

        {videos.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>{t("sessionVideos.empty")}</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {videos.map((v) => (
              <li
                key={v.id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-2)",
                  background: "var(--paper)",
                  minWidth: 0,
                }}
              >
                <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <Link href={`/videos/${v.id}`} style={{ fontWeight: 600 }}>
                    {showSession
                      ? t("sessionVideos.itemOfSession", { date: day(v.sessionDate), subject: v.subject ?? "" })
                      : t("sessionVideos.item", { date: day(v.createdAt) })}
                  </Link>
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {[
                      showSession ? t("sessionVideos.uploaded", { date: day(v.createdAt) }) : null,
                      v.uploadedBy,
                      v.durationSec ? t("sessionVideos.minutes", { minutes: Math.max(1, Math.round(v.durationSec / 60)) }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <span className={`chip ${v.status === "ready" ? "chip-lichen" : v.status === "failed" ? "chip-rust" : ""}`}>
                  {t(`status.${v.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
