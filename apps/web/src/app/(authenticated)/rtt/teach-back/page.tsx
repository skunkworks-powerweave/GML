// /rtt/teach-back — expert-review queue for teach-back video submissions.
// Synthesised from the GML design language (no JSX prototype) using
// /mentorship and /videos as the visual reference. Selection of the right-pane
// preview is driven by ?id=<submissionId> so the route stays a pure server
// component — every "open" hits the database fresh, which is exactly what a
// reviewer wants when they're about to mark something reviewed.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, teachers, users } from "@gml/db/schema";
import { auth } from "@/auth";
import { isUuid } from "@/lib/authz";
import { parsePage } from "@/lib/observation/list";
import { isPendingTeachBackReview, pendingTeachBackReviewWhere } from "@/lib/video/pending-review";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Teach-back submissions" };

const READ_ROLES = new Set(["super_admin", "programme_admin", "mentor", "observer"]);

const PAGE_SIZE = 80;

// Keyed on REVIEW STATE, not on video_submissions.status. The keys used to be
// looked up with the raw status, but review_pending / reviewed are statuses
// nothing writes (review is reviewed_at since migration 0022), so every chip
// fell through to neutral grey and a reviewed clip looked exactly like one
// still owed a review -- on the All tab, where the dashboard to-do lands.
const STATUS_CHIP: Record<"review_pending" | "reviewed", { bg: string; ink: string }> = {
  review_pending: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  reviewed: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
};

const NEUTRAL_CHIP = { bg: "var(--paper-2)", ink: "var(--ink-3)" };

/** Reviewed, owed a review (the shared definition), or its pipeline status. */
function chipFor(r: { status: string; reviewedAt: Date | null }) {
  if (r.reviewedAt !== null) return { ...STATUS_CHIP.reviewed, label: "reviewed" };
  if (isPendingTeachBackReview({ contextType: "teach_back", status: r.status, reviewedAt: r.reviewedAt })) {
    return { ...STATUS_CHIP.review_pending, label: "pending review" };
  }
  return { ...NEUTRAL_CHIP, label: r.status.replace("_", " ") };
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
  searchParams: Promise<{ id?: string; status?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!READ_ROLES.has(session.user.role)) redirect("/forbidden");

  const sp = await searchParams;
  const filter = sp.status === "review_pending" || sp.status === "reviewed" ? sp.status : undefined;

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
  //
  // THE TAB IS A SQL PREDICATE, APPLIED BEFORE THE LIMIT. The page used to load
  // the 80 newest teach-backs programme-wide and filter and count THOSE in
  // memory. Reviewed clips never leave that set, so once 80 newer teach-backs
  // existed an unreviewed clip older than them vanished from every tab while
  // the dashboard card and the sidebar badge still counted it -- and this page
  // holds the only "Mark reviewed" form. Now the tab's predicate is in the
  // WHERE, the counts are aggregates over every teach-back, and the list pages.
  const isTeachBack = eq(videoSubmissions.contextType, "teach_back");
  const tabWhere =
    filter === "review_pending"
      ? pendingTeachBackReviewWhere()
      : filter === "reviewed"
        ? and(isTeachBack, isNotNull(videoSubmissions.reviewedAt))
        : isTeachBack;
  // Pending is oldest first: the review target is on age, so the overdue clips
  // lead. id breaks ties, so the order is total and pages cannot overlap.
  const order =
    filter === "review_pending"
      ? [asc(videoSubmissions.createdAt), asc(videoSubmissions.id)]
      : [desc(videoSubmissions.createdAt), desc(videoSubmissions.id)];

  const [countRow] = await db
    .select({
      all: count(),
      reviewPending: sql<number>`count(*) filter (where ${pendingTeachBackReviewWhere()})`.mapWith(Number),
      reviewed: sql<number>`count(*) filter (where ${videoSubmissions.reviewedAt} is not null)`.mapWith(Number),
    })
    .from(videoSubmissions)
    .where(isTeachBack);
  const counts = {
    all: countRow?.all ?? 0,
    review_pending: countRow?.reviewPending ?? 0,
    reviewed: countRow?.reviewed ?? 0,
  };
  const total = filter ? counts[filter] : counts.all;
  // Past the end is the last page (a stale ?page= kept across a review).
  const page = Math.min(parsePage(sp.page), Math.max(1, Math.ceil(total / PAGE_SIZE)));

  const select = () =>
    db
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
      .leftJoin(teachers, eq(teachers.userId, users.id));

  // Right-pane selection is loaded BY ID, not looked up in the page shown: a
  // deep link (the dashboard to-do, a notification) must open the review pane
  // whatever page the clip is on. It still has to satisfy the active tab, so
  // switching to "Reviewed" with a pending row open clears the selection.
  // A malformed id cannot name a row (and would be a 22P02 from Postgres).
  const [rows, selectedRows]: [Row[], Row[]] = await Promise.all([
    select()
      .where(tabWhere)
      .orderBy(...order)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    isUuid(sp.id) ? select().where(and(tabWhere, eq(videoSubmissions.id, sp.id))).limit(1) : Promise.resolve([]),
  ]);
  const selected = selectedRows[0] ?? null;
  const selectedId = selected?.id;
  const from = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + rows.length;
  const hasNext = page * PAGE_SIZE < total;

  // A filter link carries no page, so changing tab starts again at page 1.
  const filterHref = (next: string | undefined) => {
    const params = new URLSearchParams();
    if (next) params.set("status", next);
    return params.toString() ? `?${params.toString()}` : "/rtt/teach-back";
  };

  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (filter) params.set("status", filter);
    if (n > 1) params.set("page", String(n));
    return params.toString() ? `?${params.toString()}` : "/rtt/teach-back";
  };

  // #review: opening a row scrolls to the pane. Next's Link keeps the scroll
  // position otherwise, and on a phone the pane is under the whole list (up
  // to PAGE_SIZE rows and the pager), so a tap changed nothing a mentor could
  // see but the row's own border. On a desktop the pane sits at the top of
  // the list, above a row scrolled down to.
  const rowHref = (id: string) => {
    const params = new URLSearchParams();
    if (filter) params.set("status", filter);
    if (page > 1) params.set("page", String(page));
    params.set("id", id);
    return `?${params.toString()}#review`;
  };

  return (
    <div>
      <header
        style={{
          marginBottom: 22,
          display: "flex",
          // On a phone the "All pending review" link goes under the title
          // rather than being squeezed to one word a line beside it.
          flexWrap: "wrap",
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

      {/* Wraps: three tabs with their counts are wider than a phone. A named
          nav, like the other RTT filters, and the tab that is on says so
          (aria-current): it was shown by its fill alone (F135). */}
      <nav aria-label="Filter by review state" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 16 }}>
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
              aria-current={isActive ? "page" : undefined}
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
      </nav>

      {/* PHONE WIDTH (F11). With a submission open, the list and the review
          pane were an inline "minmax(0, 2fr) minmax(0, 3fr)" at every width:
          on a phone, a ~120 px list beside a ~180 px pane whose label column
          alone is 120 px. Below 768 px the pane now sits under the list. */}
      <section
        className={
          selected
            ? "grid grid-cols-1 items-start gap-[18px] md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
            : "grid grid-cols-1 items-start gap-[18px]"
        }
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
                const chip = chipFor(r);
                const isSelected = selectedId === r.id;
                return (
                  <li key={r.id}>
                    {/* aria-current: the open row was told only by its border
                        and fill, which a phone user scrolling back up from
                        the pane, or a screen reader, cannot go by. */}
                    <Link
                      href={rowHref(r.id)}
                      aria-current={isSelected ? "true" : undefined}
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
                        {chip.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {total > 0 ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              <span>{`Showing ${from}–${to} of ${total}`}</span>
              <span style={{ display: "flex", gap: 8 }}>
                {page > 1 ? (
                  <Link href={pageHref(page - 1)} className="btn btn-sm">
                    ← Previous
                  </Link>
                ) : null}
                {hasNext ? (
                  <Link href={pageHref(page + 1)} className="btn btn-sm">
                    Next →
                  </Link>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>

        {/* Right: preview pane. id="review" is what every row links to;
            scroll-margin keeps its top clear of the sticky header (the
            topbar, or MobileShell's) that the jump would otherwise put it
            under. */}
        {selected ? (
          <article
            id="review"
            style={{
              scrollMarginTop: 80,
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
                  background: chipFor(selected).bg,
                  color: chipFor(selected).ink,
                  borderRadius: 999,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {chipFor(selected).label}
              </span>
            </header>

            <dl
              style={{
                display: "grid",
                // minmax(0, 1fr): a bare 1fr is as wide as its content.
                gridTemplateColumns: "120px minmax(0, 1fr)",
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
              ) : !isPendingTeachBackReview({ contextType: "teach_back", status: selected.status, reviewedAt: null }) ? (
                // Not playable yet (or failed). The button used to render for
                // every unreviewed row, and a review recorded now would keep
                // the clip out of "Pending review" once it became watchable;
                // the review route refuses it too. A failed clip is not on its
                // way: nothing but an operator's retry from Transcode jobs
                // moves it, so it is not told to wait like the others.
                <span style={{ padding: "8px 0", color: "var(--ink-3)", fontSize: 12 }}>
                  {selected.status === "failed"
                    ? "This video failed to process. Ask a programme admin to retry it."
                    : `Review opens once the video is ready (status: ${selected.status.replace("_", " ")}).`}
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
