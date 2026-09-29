// /rtt/teach-back — expert-review queue for teach-back video submissions.
// Synthesised from the GML design language (no JSX prototype) using
// /mentorship and /videos as the visual reference. Selection of the right-pane
// preview is driven by ?id=<submissionId> so the route stays a pure server
// component — every "open" hits the database fresh, which is exactly what a
// reviewer wants when they're about to decide on something.
//
// REVIEW IS A DECISION WITH FEEDBACK. The pane's one "Mark reviewed" button
// told the teacher nothing. It is now Approve or Request changes, with written
// feedback (required to request changes) the teacher reads on her subject
// page; the decision goes through the approvals queue (lib/rtt/teach-back.ts,
// POST /api/teach-back/[id]/review). A mentor decides only her own mentees'
// teach-backs: another teacher's is listed (the queue is programme-wide, as
// the badge is) but its pane offers her no decision.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { rttSubjects, videoSubmissions, teachers, users } from "@gml/db/schema";
import { auth } from "@/auth";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { isUuid } from "@/lib/authz";
import { latestApprovals } from "@/lib/approvals";
import { parsePage } from "@/lib/observation/list";
import { mayReviewTeachBack } from "@/lib/rtt/teach-back";
import { isPendingTeachBackReview, pendingTeachBackReviewWhere } from "@/lib/video/pending-review";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("teachBack.metaTitle") };
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** video_status values with a label under rtt.videoStatus. */
const VIDEO_STATUSES = new Set(["received", "queued", "transcoding", "ready", "failed", "review_pending", "reviewed"]);
/** video_source values with a label under rtt.videoSource. */
const VIDEO_SOURCES = new Set(["direct", "whatsapp", "external_link", "google_drive"]);

/** A pipeline status as a reviewer reads it. */
const statusText = (status: string, t: Translate) =>
  VIDEO_STATUSES.has(status) ? t(`videoStatus.${status}`) : status.replace("_", " ");

const READ_ROLES = new Set(["super_admin", "programme_admin", "mentor", "observer"]);

const PAGE_SIZE = 80;

/** Refusals the review route sends a browser back with (?error=), each with a line under rtt.teachBack.error. */
const REVIEW_ERRORS = new Set(["feedback_required", "already_reviewed", "not_allowed", "invalid_decision"]);

// Keyed on REVIEW STATE, not on video_submissions.status. The keys used to be
// looked up with the raw status, but review_pending / reviewed are statuses
// nothing writes (review is reviewed_at since migration 0022), so every chip
// fell through to neutral grey and a reviewed clip looked exactly like one
// still owed a review -- on the All tab, where the dashboard to-do lands.
const STATUS_CHIP: Record<"review_pending" | "reviewed" | "changes", { bg: string; ink: string }> = {
  review_pending: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  reviewed: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  changes: { bg: "var(--rust-soft)", ink: "var(--rust)" },
};

const NEUTRAL_CHIP = { bg: "var(--paper-2)", ink: "var(--ink-3)" };

/** A teach-back's latest review request (lib/approvals latestApprovals). */
type Decision = { status: string; comment: string | null; decidedAt: Date | null };

/**
 * The decision taken, reviewed (a clip reviewed before decisions existed),
 * owed a review (the shared definition), or its pipeline status.
 */
function chipFor(r: { status: string; reviewedAt: Date | null }, decision: Decision | undefined, t: Translate) {
  if (decision?.status === "approved") return { ...STATUS_CHIP.reviewed, label: t("teachBack.chipApproved") };
  if (decision?.status === "changes_requested" || decision?.status === "rejected") {
    return { ...STATUS_CHIP.changes, label: t("teachBack.chipChanges") };
  }
  if (r.reviewedAt !== null) return { ...STATUS_CHIP.reviewed, label: t("teachBack.chipReviewed") };
  if (isPendingTeachBackReview({ contextType: "teach_back", status: r.status, reviewedAt: r.reviewedAt })) {
    return { ...STATUS_CHIP.review_pending, label: t("teachBack.chipPending") };
  }
  return { ...NEUTRAL_CHIP, label: statusText(r.status, t) };
}

function fmtDate(d: Date | null | undefined, intl: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(intl, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(d: Date | null | undefined, intl: string) {
  if (!d) return "—";
  return new Date(d).toLocaleString(intl, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(sec: number | null | undefined, t: Translate) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return t("teachBack.duration", { minutes: m, seconds: s.toString().padStart(2, "0") });
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
  /** Who reviewed it: the account's name, else its email. */
  reviewedBy: string | null;
  teacherName: string | null;
  teacherHindi: string | null;
  teacherSubject: string | null;
  /** The RTT subject taught back (the context id, uploads/context.ts); null for a clip from before it was one. */
  rttSubjectName: string | null;
};

export default async function TeachBackQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; status?: string; page?: string; error?: string; reviewed?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!READ_ROLES.has(session.user.role)) redirect("/forbidden");
  const actor = { id: session.user.id, role: session.user.role };
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];

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
        reviewedBy: sql<string | null>`(SELECT coalesce(r.name, r.email) FROM users r WHERE r.id = ${videoSubmissions.reviewedByUserId})`,
        teacherName: teachers.fullName,
        teacherHindi: teachers.hindiName,
        teacherSubject: teachers.subjectSpecialism,
        rttSubjectName: rttSubjects.name,
      })
      .from(videoSubmissions)
      .leftJoin(users, eq(videoSubmissions.submittedByUserId, users.id))
      .leftJoin(teachers, eq(teachers.userId, users.id))
      .leftJoin(rttSubjects, eq(rttSubjects.id, videoSubmissions.contextId));

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
  // Each listed clip's latest decision, and whether this reviewer may decide
  // the open one (her own mentees only, for a mentor).
  const decisions = await latestApprovals(db, "teach_back", [...new Set([...rows, ...selectedRows].map((r) => r.id))]);
  const selectedDecision = selected ? decisions.get(selected.id) : undefined;
  const decided = selectedDecision && selectedDecision.status !== "pending" ? selectedDecision : undefined;
  const mayReview = selected ? await mayReviewTeachBack(db, actor, selected.id) : false;
  // What the review route sent back to this clip for (?error=).
  const reviewError = selected && sp.id === selected.id && sp.error && REVIEW_ERRORS.has(sp.error) ? sp.error : null;
  const justReviewed = isUuid(sp.reviewed);
  // The Approve / Request changes form is shown for a playable clip nobody has
  // decided yet, to a reviewer who may decide it.
  const formShown =
    !!selected &&
    !decided &&
    selected.reviewedAt === null &&
    isPendingTeachBackReview({ contextType: "teach_back", status: selected.status, reviewedAt: null }) &&
    mayReview;
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
            {t("teachBack.eyebrow")}
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
            {t("teachBack.title")}
          </h1>
          <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 620 }}>
            {t("teachBack.intro")}
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
          {t("teachBack.allPending")}
        </Link>
      </header>

      {/* After a decision the route comes back here (?reviewed=<id>). */}
      {justReviewed ? (
        <p
          role="status"
          style={{
            margin: "0 0 14px",
            padding: "8px 12px",
            background: "var(--lichen-soft)",
            color: "var(--lichen)",
            borderRadius: "var(--r-2)",
            fontSize: 12,
          }}
        >
          {t("teachBack.decisionRecorded")}
        </p>
      ) : null}

      {/* Wraps: three tabs with their counts are wider than a phone. A named
          nav, like the other RTT filters, and the tab that is on says so
          (aria-current): it was shown by its fill alone (F135). */}
      <nav aria-label={t("teachBack.filterLabel")} style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 16 }}>
        {(
          [
            { v: undefined, l: t("common.all"), n: counts.all },
            { v: "review_pending", l: t("teachBack.tabPending"), n: counts.review_pending },
            { v: "reviewed", l: t("teachBack.tabReviewed"), n: counts.reviewed },
          ] as const
        ).map((f) => {
          const isActive = filter === f.v || (!filter && !f.v);
          return (
            <Link
              key={f.v ?? "all"}
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
              {filter ? t("teachBack.emptyWithStatus", { status: statusText(filter, t) }) : t("teachBack.empty")}
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rows.map((r) => {
                const chip = chipFor(r, decisions.get(r.id), t);
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
                          {r.teacherName ?? t("teachBack.unknownTeacher")}
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
                          {/* What she taught back, then her own specialism. */}
                          {r.rttSubjectName ? <span>{r.rttSubjectName} ·</span> : null}
                          <span>{r.teacherSubject || "—"}</span>
                          <span style={{ fontFamily: "var(--mono)" }}>· {fmtDate(r.createdAt, intl)}</span>
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
              <span>{t("teachBack.showing", { from, to, total })}</span>
              <span style={{ display: "flex", gap: 8 }}>
                {page > 1 ? (
                  <Link href={pageHref(page - 1)} className="btn btn-sm">
                    {t("common.previous")}
                  </Link>
                ) : null}
                {hasNext ? (
                  <Link href={pageHref(page + 1)} className="btn btn-sm">
                    {t("common.next")}
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
                  {t("teachBack.submission")}
                </div>
                <h2
                  style={{
                    fontFamily: "var(--serif)",
                    fontSize: 22,
                    marginTop: 4,
                  }}
                >
                  {selected.teacherName ?? t("teachBack.unknownTeacher")}
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
                  background: chipFor(selected, selectedDecision, t).bg,
                  color: chipFor(selected, selectedDecision, t).ink,
                  borderRadius: 999,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {chipFor(selected, selectedDecision, t).label}
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
              <dt style={dtStyle}>{t("teachBack.rttSubject")}</dt>
              <dd style={ddStyle}>{selected.rttSubjectName ?? "—"}</dd>
              <dt style={dtStyle}>{t("teachBack.source")}</dt>
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
                  {VIDEO_SOURCES.has(selected.source) ? t(`videoSource.${selected.source}`) : selected.source}
                </span>
              </dd>
              <dt style={dtStyle}>{t("teachBack.submitted")}</dt>
              <dd style={{ ...ddStyle, fontFamily: "var(--mono)" }}>{fmtDateTime(selected.createdAt, intl)}</dd>
              <dt style={dtStyle}>{t("teachBack.durationLabel")}</dt>
              <dd style={{ ...ddStyle, fontFamily: "var(--mono)" }}>{fmtDuration(selected.durationSec, t)}</dd>
              <dt style={dtStyle}>HLS</dt>
              <dd style={ddStyle}>
                {selected.hlsKey ? (
                  <span style={{ color: "var(--lichen)" }}>{t("teachBack.hlsReady")}</span>
                ) : (
                  <span style={{ color: "var(--ink-3)" }}>{t("teachBack.hlsWaiting")}</span>
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
                  {t("teachBack.caption")}
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
                {t("teachBack.viewVideo")}
              </Link>
              {selected.reviewedAt !== null && !decided ? (
                // Reviewed before decisions existed: no decision to show.
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
                  {t("teachBack.alreadyReviewed")}
                </span>
              ) : selected.reviewedAt === null &&
                !isPendingTeachBackReview({ contextType: "teach_back", status: selected.status, reviewedAt: null }) ? (
                // Not playable yet (or failed). The button used to render for
                // every unreviewed row, and a review recorded now would keep
                // the clip out of "Pending review" once it became watchable;
                // the review route refuses it too. A failed clip is not on its
                // way: nothing but an operator's retry from Transcode jobs
                // moves it, so it is not told to wait like the others.
                <span style={{ padding: "8px 0", color: "var(--ink-3)", fontSize: 12 }}>
                  {selected.status === "failed"
                    ? t("teachBack.failed")
                    : t("teachBack.waitReady", { status: statusText(selected.status, t) })}
                </span>
              ) : null}
            </div>

            {decided ? (
              // The decision taken, and the feedback the teacher was sent.
              <section data-testid="teach-back-decision" style={{ display: "grid", gap: 6, fontSize: 12 }}>
                <div style={{ color: "var(--ink-3)" }}>
                  {t("teachBack.decidedBy", {
                    decision: decided.status,
                    name: selected.reviewedBy ?? t("teachBack.unknownReviewer"),
                    date: fmtDateTime(decided.decidedAt, intl),
                  })}
                </div>
                {decided.comment ? (
                  <div>
                    <div style={{ ...dtStyle, marginBottom: 4 }}>{t("teachBack.feedback")}</div>
                    <p
                      style={{
                        margin: 0,
                        background: "var(--paper)",
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-2)",
                        padding: "10px 12px",
                        color: "var(--ink-2)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {decided.comment}
                    </p>
                  </div>
                ) : null}
              </section>
            ) : selected.reviewedAt === null &&
              isPendingTeachBackReview({ contextType: "teach_back", status: selected.status, reviewedAt: null }) ? (
              mayReview ? (
                // Approve, or Request changes with the feedback she needs. One
                // form, two submit buttons (decision=...): works with no
                // JavaScript, and a single column at phone width.
                <form
                  method="POST"
                  action={`/api/teach-back/${selected.id}/review`}
                  style={{ margin: 0, display: "grid", gap: 10 }}
                >
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={dtStyle}>{t("teachBack.feedbackLabel")}</span>
                    <textarea
                      name="feedback"
                      rows={4}
                      maxLength={4000}
                      aria-describedby="teach-back-feedback-hint"
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        border: "1px solid var(--line-2)",
                        borderRadius: "var(--r-2)",
                        background: "var(--card-hi)",
                        fontSize: 13,
                        fontFamily: "inherit",
                      }}
                    />
                    <span id="teach-back-feedback-hint" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {t("teachBack.feedbackHint")}
                    </span>
                  </label>
                  {reviewError ? (
                    <p role="alert" style={{ margin: 0, color: "var(--rust)", fontSize: 12 }}>
                      {t(`teachBack.error.${reviewError}`)}
                    </p>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="submit"
                      name="decision"
                      value="approved"
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
                      {t("teachBack.approve")}
                    </button>
                    <button
                      type="submit"
                      name="decision"
                      value="changes_requested"
                      style={{
                        padding: "8px 14px",
                        background: "var(--card-hi)",
                        color: "var(--ink)",
                        border: "1px solid var(--line-2)",
                        borderRadius: "var(--r-2)",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {t("teachBack.requestChanges")}
                    </button>
                  </div>
                </form>
              ) : (
                // Listed, but not hers to decide: another mentor's mentee.
                <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 12 }}>{t("teachBack.notYourMentee")}</p>
              )
            ) : null}
            {reviewError && !formShown ? (
              <p role="alert" style={{ margin: 0, color: "var(--rust)", fontSize: 12 }}>
                {t(`teachBack.error.${reviewError}`)}
              </p>
            ) : null}
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
