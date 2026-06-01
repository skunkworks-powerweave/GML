// /inbox — per-user notifications feed.
// Spec 070: unread-first feed grouped by date, filter tabs, mark-all-read form.
// Schema: notifications (spec 025). Retention ≤ 90 days via packages/db retention script.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { notifications } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Kind → emoji glyph. Unknown kinds fall back to the bell.
const KIND_ICON: Record<string, string> = {
  "cycle.assigned": "📋",
  "video.transcoded": "🎥",
  "meeting.scheduled": "📅",
  "quiz.due": "❓",
};

// Entity type → canonical href (id is appended). Used when entityType + entityId are present.
const ENTITY_HREF: Record<string, (id: string) => string> = {
  cycle: (id) => `/observation/${id}`,
  observation_cycle: (id) => `/observation/${id}`,
  video: (id) => `/videos/${id}`,
  video_submission: (id) => `/videos/${id}`,
  meeting: (id) => `/mentorship/${id}`,
  mentor_pairing: (id) => `/mentorship/${id}`,
  pairing: (id) => `/mentorship/${id}`,
  quiz: (id) => `/quizzes/${id}`,
  session: (id) => `/repo/session/${id}`,
};

function hrefForEntity(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const fn = ENTITY_HREF[entityType];
  return fn ? fn(entityId) : null;
}

// Bucket a notification's createdAt against the request-time clock.
// Local-time aware so "Today" follows the operator's wall clock, not UTC.
function bucketFor(createdAt: Date, now: Date): "today" | "yesterday" | "week" | "older" {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  if (createdAt >= todayStart) return "today";
  if (createdAt >= yesterdayStart) return "yesterday";
  if (createdAt >= weekStart) return "week";
  return "older";
}

const BUCKET_LABEL: Record<"today" | "yesterday" | "week" | "older", string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  older: "Older",
};

// Short relative timestamp ("now", "5m", "2h", "Yesterday", "Mon 14 Apr").
function shortTime(createdAt: Date, now: Date): string {
  const diffMs = now.getTime() - createdAt.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  if (createdAt >= yesterdayStart && createdAt < todayStart) return "Yesterday";
  return createdAt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

type Row = {
  id: string;
  kind: string;
  subject: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const sp = await searchParams;
  const filter = sp.filter === "unread" ? "unread" : "all";

  // Unread-first, then most recent. Mirrors the (user_id, read_at, created_at) index from spec 025.
  // Drizzle's asc().nullsFirst() is not stable across pg-core minors — sql literal is the documented path.
  const whereClause =
    filter === "unread"
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
      : eq(notifications.userId, userId);

  const rows: Row[] = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      subject: notifications.subject,
      body: notifications.body,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(whereClause)
    .orderBy(sql`${notifications.readAt} ASC NULLS FIRST`, sql`${notifications.createdAt} DESC`)
    .limit(50);

  const now = new Date();
  const unreadCount = rows.filter((r) => r.readAt === null).length;
  const totalShown = rows.length;

  // Partition into buckets, preserving the unread-first ordering inside each bucket.
  const buckets: Record<"today" | "yesterday" | "week" | "older", Row[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  for (const r of rows) {
    buckets[bucketFor(r.createdAt, now)].push(r);
  }
  const bucketOrder: Array<"today" | "yesterday" | "week" | "older"> = ["today", "yesterday", "week", "older"];

  return (
    <div>
      <header style={{ marginBottom: 22, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
            Notifications
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Inbox</h1>
          <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
            {unreadCount} unread · {totalShown} total · last 90 days
          </p>
        </div>

        {/* Mark all read — POSTs to /api/notifications/mark-read (endpoint not in this spec). */}
        <form action="/api/notifications/mark-read" method="post">
          <button
            type="submit"
            disabled={unreadCount === 0}
            style={{
              padding: "8px 14px",
              background: unreadCount === 0 ? "var(--paper-2)" : "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              fontSize: 12,
              color: unreadCount === 0 ? "var(--ink-4)" : "var(--ink-2)",
              cursor: unreadCount === 0 ? "not-allowed" : "pointer",
              fontFamily: "var(--sans)",
            }}
          >
            Mark all read
          </button>
        </form>
      </header>

      {/* Filter tabs — All / Unread */}
      <nav style={{ display: "flex", gap: 8, marginBottom: 18, borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
        <Link
          href="/inbox"
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            fontSize: 12,
            textDecoration: "none",
            background: filter === "all" ? "var(--indigo-soft)" : "transparent",
            color: filter === "all" ? "var(--indigo)" : "var(--ink-3)",
            fontWeight: filter === "all" ? 600 : 400,
            border: "1px solid var(--line)",
          }}
        >
          All
        </Link>
        <Link
          href="/inbox?filter=unread"
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            fontSize: 12,
            textDecoration: "none",
            background: filter === "unread" ? "var(--indigo-soft)" : "transparent",
            color: filter === "unread" ? "var(--indigo)" : "var(--ink-3)",
            fontWeight: filter === "unread" ? 600 : 400,
            border: "1px solid var(--line)",
          }}
        >
          Unread
          {unreadCount > 0 ? (
            <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 11 }}>{unreadCount}</span>
          ) : null}
        </Link>
      </nav>

      {rows.length === 0 ? (
        <section
          style={{
            padding: 48,
            textAlign: "center",
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 20, marginBottom: 6 }}>
            {filter === "unread" ? "No unread notifications." : "Nothing in your inbox yet."}
          </h2>
          <p style={{ color: "var(--ink-3)", fontSize: 13, maxWidth: 420, margin: "0 auto" }}>
            Operational events — assigned cycles, transcoded videos, scheduled meetings, due quizzes — will show up
            here. Notifications are kept for 90 days (SM-8).{" "}
            <Link href="/dashboard" style={{ color: "var(--indigo)" }}>
              Back to dashboard →
            </Link>
          </p>
        </section>
      ) : (
        <section style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {bucketOrder.map((bucket) => {
            const bucketRows = buckets[bucket];
            if (bucketRows.length === 0) return null;
            return (
              <div key={bucket}>
                <h2
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--ink-3)",
                    marginBottom: 10,
                    fontWeight: 600,
                  }}
                >
                  {BUCKET_LABEL[bucket]}
                  <span style={{ marginLeft: 6, fontFamily: "var(--mono)", color: "var(--ink-4)" }}>
                    {bucketRows.length}
                  </span>
                </h2>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {bucketRows.map((row) => (
                    <NotificationRow key={row.id} row={row} now={now} />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function NotificationRow({ row, now }: { row: Row; now: Date }) {
  const unread = row.readAt === null;
  const icon = KIND_ICON[row.kind] ?? "🔔";
  const href = hrefForEntity(row.entityType, row.entityId);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "12px 14px",
    background: unread ? "var(--card-hi)" : "var(--paper-2)",
    border: "1px solid var(--line)",
    borderLeft: unread ? "3px solid var(--indigo)" : "3px solid transparent",
    borderRadius: "var(--r-3)",
    textDecoration: "none",
    color: "var(--ink)",
  };

  const content = (
    <>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 999,
          background: unread ? "var(--indigo-soft)" : "var(--paper-3)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: unread ? 600 : 500,
            fontSize: 13,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {row.subject}
        </div>
        {row.body ? (
          <div
            style={{
              color: "var(--ink-3)",
              fontSize: 12,
              marginTop: 2,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {row.body}
          </div>
        ) : null}
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--mono)" }}>
          {row.kind}
          {row.entityType ? ` · ${row.entityType}` : ""}
        </div>
      </div>
      <span style={{ flexShrink: 0, fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
        {shortTime(row.createdAt, now)}
      </span>
    </>
  );

  return (
    <li>
      {href ? (
        <Link href={href} style={rowStyle}>
          {content}
        </Link>
      ) : (
        <div style={rowStyle}>{content}</div>
      )}
    </li>
  );
}
