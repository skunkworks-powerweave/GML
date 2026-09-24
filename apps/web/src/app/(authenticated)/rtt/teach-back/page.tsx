// /rtt/teach-back — expert-review queue for teach-back video submissions.
// Synthesised from the GML design language (no JSX prototype) using
// /mentorship and /videos as the visual reference. Selection of the right-pane
// preview is driven by ?id=<submissionId> so the route stays a pure server
// component — every "open" hits the database fresh, which is exactly what a
// reviewer wants when they're about to mark something reviewed.

import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, teachers, users } from "@gml/db/schema";
import { auth } from "@/auth";
import { isPendingTeachBackReview } from "@/lib/video/pending-review";

export const dynamic = "force-dynamic";

const READ_ROLES = new Set(["super_admin", "programme_admin", "mentor", "observer"]);

const STATUS_CHIP: Record<string, { bg: string; ink: string }> = {
  review_pending: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  reviewed: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
};

const NEUTRAL_CHIP = { bg: "var(--paper-2)", ink: "var(--ink-3)" };

function chipFor(status: string) {
  return STATUS_CHIP[status] ?? NEUTRAL_CHIP;
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(d: Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(sec: number | null | undefined) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

type Row = {
  id: string;
  status: string;
  createdAt: Date;
  durationSec: number | null;
  source: "direct" | "whatsapp" | "external_link" | "google_drive";
  captionRaw: string | null;
  hlsKey: string | null;
  /** Null until a mentor/observer reviews it. Review is NOT a `status` value. */
  reviewedAt: Date | null;
  teacherName: string | null;
  teacherHindi: string | null;
  teacherSubject: string | null;
};

export default async function TeachBackQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; status?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!READ_ROLES.has(session.user.role)) redirect("/forbidden");

  const sp = await searchParams;
  const filter = sp.status === "review_pending" || sp.status === "reviewed" ? sp.status : undefined;

  const baseRows: Row[] = await db
    .select({
      id: videoSubmissions.id,
      status: videoSubmissions.status,
      createdAt: videoSubmissions.createdAt,
      durationSec: videoSubmissions.durationSec,
      source: videoSubmissions.source,
      captionRaw: videoSubmissions.captionRaw,
      hlsKey: videoSubmissions.hlsMasterKey,
      reviewedAt: videoSubmissions.reviewedAt,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
      teacherSubject: teachers.subjectSpecialism,
    })
    .from(videoSubmissions)
    .leftJoin(users, eq(videoSubmissions.submittedByUserId, users.id))
    .leftJoin(teachers, eq(teachers.userId, users.id))
    .where(eq(videoSubmissions.contextType, "teach_back"))
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(80);

  // Review state is now a timestamp, not a value of `status`. These counters
  // previously tested status === "review_pending", which NOTHING in the codebase
  // ever wrote -- the worker writes ready/failed and the webhook writes received
  // -- so "Pending review" was permanently zero while every unreviewed clip sat
  // in the queue uncounted. See migration 0022.
  //
  // "Pending review" is the shared definition in lib/video/pending-review.ts
  // (playable AND unreviewed), the same one the dashboard card and the sidebar
  // badge count. It used to be `reviewedAt === null` alone, which also counted
  // clips still uploading or transcoding -- clips nobody can review yet -- so
  // this tab disagreed with both of them. Those clips still appear under "All".
  const isReviewed = (r: Row) => r.reviewedAt !== null;
  const isPending = (r: Row) =>
    isPendingTeachBackReview({ contextType: "teach_back", status: r.status, reviewedAt: r.reviewedAt });
  const rows = filter
    ? baseRows.filter((r) => (filter === "reviewed" ? isReviewed(r) : isPending(r)))
    : baseRows;
  const counts = {
    all: baseRows.length,
    review_pending: baseRows.filter(isPending).length,
    reviewed: baseRows.filter(isReviewed).length,
  };

  // Right-pane selection — clear ?id if it isn't in the current filtered view
  // (e.g. the reviewer switched filter to "Reviewed" while having a pending row open).
  const selectedId = sp.id && rows.some((r) => r.id === sp.id) ? sp.id : undefined;
  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;

  const filterHref = (next: string | undefined) => {
    const params = new URLSearchParams();
    if (next) params.set("status", next);
    return params.toString() ? `?${params.toString()}` : "/rtt/teach-back";
  };

  const rowHref = (id: string) => {
    const params = new URLSearchParams();
    if (filter) params.set("status", filter);
    params.set("id", id);
    return `?${params.toString()}`;
  };

  return (
    <div>
      <header
        style={{
          marginBottom: 22,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--ink-3)",
            }}
          >
            Refresher Teacher Training
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
            Teach-back submissions
          </h1>
          <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 620 }}>
            Expert-review queue for teacher self-recorded teach-back videos. Click a row to preview;
            mark reviewed once you have scored it. Pending submissions are saffron, reviewed are
            lichen.
          </p>
        </div>
        {/* Points at THIS queue's pending filter, not /videos?status=review_pending.
            `review_pending` is a member of the video_status enum that nothing in
            the codebase has ever written -- the worker writes ready/failed and
            the webhook writes received -- so /videos filtered on it returned an
            empty list every time. Review state is a timestamp (reviewed_at,
            migration 0022), which /videos cannot express and this page already
            reads correctly. */}
        <Link
          href="/rtt/teach-back?status=review_pending"
          style={{
            padding: "7px 12px",
            background: "var(--card-hi)",
            color: "var(--ink)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2)",
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          All pending review
        </Link>
      </header>

      <section style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(
          [
            { v: undefined, l: "All", n: counts.all },
            { v: "review_pending", l: "Pending review", n: counts.review_pending },
            { v: "reviewed", l: "Reviewed", n: counts.reviewed },
          ] as const
        ).map((f) => {
          const isActive = filter === f.v || (!filter && !f.v);
          return (
            <Link
              key={f.l}
              href={filterHref(f.v)}
              style={{
                padding: "6px 12px",
                background: isActive ? "var(--ink)" : "transparent",
                color: isActive ? "var(--paper)" : "var(--ink-2)",
                border: isActive ? "1px solid var(--ink)" : "1px solid transparent",
                borderRadius: "var(--r-2)",
                fontSize: 12,
                textDecoration: "none",
              }}
            >
              {f.l} <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
            </Link>
          );
        })}
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: selected ? "minmax(0, 2fr) minmax(0, 3fr)" : "minmax(0, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* Left: submission list */}
        <div
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
            overflow: "hidden",
          }}
        >
          {rows.length === 0 ? (
            <div style={{ padding: 32, color: "var(--ink-3)", textAlign: "center", fontSize: 13 }}>
              No teach-back submissions {filter ? `with status ${filter.replace("_", " ")}` : "yet"}.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rows.map((r) => {
                const chip = chipFor(r.status);
                const isSelected = selectedId === r.id;
                return (
                  <li key={r.id}>
                    <Link
                      href={rowHref(r.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "12px 14px",
                        borderLeft: isSelected ? "3px solid var(--ink)" : "3px solid transparent",
                        background: isSelected ? "var(--paper-2)" : "transparent",
                        borderBottom: "1px solid var(--line)",
                        textDecoration: "none",
                        color: "var(--ink)",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>
                          {r.teacherName ?? "(unknown teacher)"}
                          {r.teacherHindi ? (
                            <span
                              style={{
                                fontFamily: "var(--deva)",
                                color: "var(--ink-3)",
                                marginLeft: 8,
                                fontSize: 12,
                              }}
                            >
                              {r.teacherHindi}
                            </span>
                          ) : null}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--ink-3)",
                            marginTop: 3,
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <span>{r.teacherSubject || "—"}</span>
                          <span style={{ fontFamily: "var(--mono)" }}>· {fmtDate(r.createdAt)}</span>
                        </div>
                      </div>
                      <span
                        style={{
                          padding: "2px 8px",
                          background: chip.bg,
                          color: chip.ink,
                          borderRadius: 999,
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.status.replace("_", " ")}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: preview pane */}
        {selected ? (
          <article
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--ink-3)",
                  }}
                >
                  Teach-back submission
                </div>
                <h2
                  style={{
                    fontFamily: "var(--serif)",
                    fontSize: 22,
                    marginTop: 4,
                  }}
                >
                  {selected.teacherName ?? "(unknown teacher)"}
                  {selected.teacherHindi ? (
                    <span
                      style={{
                        fontFamily: "var(--deva)",
                        color: "var(--ink-3)",
                        marginLeft: 10,
                        fontSize: 18,
                      }}
                    >
                      {selected.teacherHindi}
                    </span>
                  ) : null}
                </h2>
                {selected.teacherSubject ? (
                  <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
                    {selected.teacherSubject}
                  </div>
                ) : null}
              </div>
              <span
                style={{
                  padding: "3px 10px",
                  background: chipFor(selected.status).bg,
                  color: chipFor(selected.status).ink,
                  borderRadius: 999,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {selected.status.replace("_", " ")}
              </span>
            </header>

            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr",
                rowGap: 8,
                columnGap: 12,
                margin: 0,
                fontSize: 12,
              }}
            >
              <dt style={dtStyle}>Source</dt>
              <dd style={ddStyle}>
                <span
                  style={{
                    padding: "2px 8px",
                    background: "var(--paper-2)",
                    color: "var(--ink-2)",
                    borderRadius: 4,
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                  }}
                >
                  {selected.source}
                </span>
              </dd>
              <dt style={dtStyle}>Submitted</dt>
              <dd style={{ ...ddStyle, fontFamily: "var(--mono)" }}>{fmtDateTime(selected.createdAt)}</dd>
              <dt style={dtStyle}>Duration</dt>
              <dd style={{ ...ddStyle, fontFamily: "var(--mono)" }}>{fmtDuration(selected.durationSec)}</dd>
              <dt style={dtStyle}>HLS</dt>
              <dd style={ddStyle}>
                {selected.hlsKey ? (
                  <span style={{ color: "var(--lichen)" }}>ready</span>
                ) : (
                  <span style={{ color: "var(--ink-3)" }}>waiting on transcode</span>
                )}
              </dd>
            </dl>

            {selected.captionRaw ? (
              <div>
                <div
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--ink-3)",
                    marginBottom: 6,
                  }}
                >
                  Caption
                </div>
                <div
                  style={{
                    background: "var(--paper)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2)",
                    padding: "10px 12px",
                    fontSize: 12,
                    color: "var(--ink-2)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {selected.captionRaw}
                </div>
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              <Link
                href={`/videos/${selected.id}`}
                prefetch={false}
                style={{
                  padding: "8px 14px",
                  background: "var(--card-hi)",
                  color: "var(--ink)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-2)",
                  fontSize: 12,
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                View video
              </Link>
              {selected.reviewedAt !== null ? (
                <span
                  style={{
                    padding: "8px 14px",
                    background: "var(--lichen-soft)",
                    color: "var(--lichen)",
                    borderRadius: "var(--r-2)",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Already reviewed
                </span>
              ) : (
                <form
                  method="POST"
                  action={`/api/teach-back/${selected.id}/review`}
                  style={{ margin: 0 }}
                >
                  <button
                    type="submit"
                    style={{
                      padding: "8px 14px",
                      background: "var(--ink)",
                      color: "var(--paper)",
                      border: "none",
                      borderRadius: "var(--r-2)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    Mark reviewed
                  </button>
                </form>
              )}
            </div>
          </article>
        ) : null}
      </section>
    </div>
  );
}

const dtStyle: React.CSSProperties = {
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontSize: 10,
  fontWeight: 600,
  alignSelf: "center",
};

const ddStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--ink-2)",
};
