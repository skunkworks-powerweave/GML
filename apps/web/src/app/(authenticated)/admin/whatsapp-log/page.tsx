// /admin/whatsapp-log — WhatsApp ingest log (Workflow Run 10 frontend parity).
//
// Spec 126 closes the LMS GML Frontend/videos.jsx:33 affordance: the
// prototype's "WhatsApp ingest log" header button. Before this spec, the
// live videos library routed it at /admin/audit?action=whatsapp. — but
// the audit-log surface has no LIKE filter so that URL matched zero
// rows. This page replaces that broken hop with a dedicated operator-
// grade view that:
//
//   - lists every video_submission whose source='whatsapp',
//   - shows the original sender phone (video_submissions.whatsapp_from;
//     for rows older than migration 0036, the matching
//     'whatsapp.message.received' audit row's metadata.from, found by
//     message id),
//   - shows the truncated caption (video_submissions.caption_raw),
//     parsed context (matched / unmatched, color-coded), submission
//     status chip, and a /videos/<id> deep link,
//   - provides "Resend transcode" CTA for stuck rows via the server
//     action in ./actions.ts,
//   - filters by parsing result (matched / unmatched) and date range.
//
// Role gate: programme_admin + super_admin only (matches the
// programme-oversight semantics of /admin/audit and /admin/gates).

import Link from "next/link";
import { desc, eq, and, gte, lte, inArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, auditLog, files } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { whatsappHealth } from "@/lib/health";
import { resendTranscodeAction, retryWhatsAppFetchAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 100;

// Status → chip class mirrors the videos library page so the same status
// reads the same way across both surfaces.
const STATUS_CHIP: Record<string, string> = {
  ready: "chip-lichen",
  transcoding: "chip-saffron",
  queued: "chip",
  received: "chip",
  failed: "chip-rust",
  review_pending: "chip-saffron",
  reviewed: "chip-indigo",
};

// context_type='generic' is the only "unmatched" outcome — every other
// context_type means the webhook successfully parsed the caption prefix
// (OBS-/TB-/MM-) and resolved the parent entity (or accepted a UUID
// caption-supplied id). See api/webhooks/whatsapp/route.ts.
const MATCHED_CONTEXTS = [
  "observation_cycle",
  "teach_back",
  "mentor_meeting",
  "mentee_quarterly",
  "classroom_session",
] as const;

// Re-encoding a finalised video can't help and risks SM-3. Only these
// states surface a Resend button.
const RESENDABLE_STATUSES = new Set([
  "received",
  "queued",
  "transcoding",
  "failed",
]);

function chipForContext(contextType: string): string {
  if (contextType === "generic") return "chip chip-rust";
  return "chip chip-lichen";
}

function parsingLabel(contextType: string): "matched" | "unmatched" {
  return contextType === "generic" ? "unmatched" : "matched";
}

export default async function WhatsappIngestLogPage({
  searchParams,
}: {
  searchParams: Promise<{ parsing?: string; from?: string; to?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  const sp = await searchParams;

  // Audit the surface view itself — programme-admin oversight tooling is
  // SM-9-tracked the same way /admin/gates is.
  void recordAudit({
    action: "whatsapp.log.surface_viewed",
    entityType: "video_submission",
    metadata: { parsing: sp.parsing ?? "any", from: sp.from ?? null, to: sp.to ?? null },
  });

  // Build the WHERE clause for video_submissions. Always pinned to
  // source='whatsapp'; optional parsing + date filters layered on top.
  const conds = [eq(videoSubmissions.source, "whatsapp")];

  if (sp.parsing === "matched") {
    conds.push(inArray(videoSubmissions.contextType, [...MATCHED_CONTEXTS]));
  } else if (sp.parsing === "unmatched") {
    conds.push(eq(videoSubmissions.contextType, "generic"));
  }

  if (sp.from) {
    const fromDate = new Date(sp.from);
    if (!Number.isNaN(fromDate.getTime())) {
      conds.push(gte(videoSubmissions.createdAt, fromDate));
    }
  }
  if (sp.to) {
    // Inclusive end-of-day: append 23:59:59 so a date range from=2026-05-01
    // to=2026-05-01 still picks up rows from later that same day.
    const toDate = new Date(sp.to);
    if (!Number.isNaN(toDate.getTime())) {
      toDate.setHours(23, 59, 59, 999);
      conds.push(lte(videoSubmissions.createdAt, toDate));
    }
  }

  const rows = await db
    .select({
      id: videoSubmissions.id,
      status: videoSubmissions.status,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      captionRaw: videoSubmissions.captionRaw,
      createdAt: videoSubmissions.createdAt,
      processingLog: videoSubmissions.processingLog,
      mediaId: videoSubmissions.whatsappMediaId,
      whatsappFrom: videoSubmissions.whatsappFrom,
      whatsappMessageId: videoSubmissions.whatsappMessageId,
      fileStatus: files.status,
      // The webhook records a submission BEFORE its media is fetched, so a row
      // can be waiting on the worker's fetch. Its latest error is the one thing
      // that says why -- a missing token, a Graph 401, a Storage refusal.
      fetchError: sql<string | null>`(
        SELECT j.last_error FROM jobs j
         WHERE j.queue = 'whatsapp' AND j.dedupe_key = 'wa:' || ${videoSubmissions.whatsappMessageId}
         ORDER BY j.created_at DESC LIMIT 1)`,
    })
    .from(videoSubmissions)
    .innerJoin(files, eq(files.id, videoSubmissions.fileId))
    .where(and(...conds))
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(PAGE_LIMIT);

  // The integration's own state, first. A partly configured deployment -- the
  // secret set, the access token not -- accepted every video and fetched none,
  // and this page, the one an operator opens when a teacher says "I sent it",
  // said nothing about why.
  const health = await whatsappHealth();
  const MISSING_EFFECT: Record<string, string> = {
    WHATSAPP_VERIFY_TOKEN: "Meta's webhook verification is refused",
    WHATSAPP_ACCESS_TOKEN: "videos are recorded but cannot be fetched from Meta",
    WHATSAPP_PHONE_NUMBER_ID: "senders get no reply",
  };

  // WHO SENT IT. The webhook writes the sender onto the submission
  // (video_submissions.whatsapp_from, migration 0036), and that is read first.
  //
  // This used to come only from the 'whatsapp.message.received' audit rows,
  // joined on audit_log.entity_id -- which the webhook never set, because it
  // wrote that row before the submission existed. The join could not match, so
  // the column read "—" for every row, including the unmatched videos from
  // numbers on file for nobody, where the sender is the operator's only clue.
  //
  // Rows from before 0036 have no whatsapp_from; for those the audit row is
  // still the only record, and it is found by the message id it DOES carry.
  const phoneBySubmissionId = new Map<string, string>();
  const needAudit = new Map<string, string>(); // whatsapp_message_id -> submission id
  for (const r of rows) {
    if (r.whatsappFrom) phoneBySubmissionId.set(r.id, r.whatsappFrom);
    else if (r.whatsappMessageId) needAudit.set(r.whatsappMessageId, r.id);
  }

  if (needAudit.size > 0) {
    const audits = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "whatsapp.message.received"),
          inArray(sql<string>`${auditLog.metadata} ->> 'msgId'`, [...needAudit.keys()]),
        ),
      )
      .limit(needAudit.size * 2);

    for (const a of audits) {
      const md = (a.metadata ?? {}) as Record<string, unknown>;
      const from = typeof md.from === "string" ? md.from : null;
      const submissionId = typeof md.msgId === "string" ? needAudit.get(md.msgId) : undefined;
      if (from && submissionId) phoneBySubmissionId.set(submissionId, from);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">WhatsApp ingest log</h1>
        <p className="text-sm text-neutral-500">
          Every video sent to the GML WhatsApp number. A caption carrying
          OBS- / TB- / MM- and a code the sender may use links the upload to
          that observation cycle, teach-back, or mentor meeting; everything
          else is kept as a generic submission, visible to admins and the
          sender, with its caption and sender shown here. The app has no
          control yet for attaching a generic video to a cycle afterwards:
          ask the teacher to send it again with the cycle code as the caption.
        </p>
      </header>

      {health.state !== "on" ? (
        <section
          className="rounded-lg border border-neutral-200 bg-white p-4 text-sm"
          data-testid="whatsapp-config"
          role="status"
        >
          {health.state === "off" ? (
            <p>
              WhatsApp ingest is off: WHATSAPP_APP_SECRET is not set, so the webhook refuses all
              traffic. Direct upload is unaffected.
            </p>
          ) : (
            <>
              <p className="font-medium">WhatsApp ingest is only partly configured.</p>
              <ul className="mt-1 list-disc pl-5">
                {health.missing.map((name) => (
                  <li key={name}>
                    <span className="font-mono">{name}</span> is not set: {MISSING_EFFECT[name] ?? "see README-IT.md"}.
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
      {health.deadFetches24h ? (
        <p className="text-sm text-rust" role="status">
          {health.deadFetches24h} WhatsApp video fetch(es) gave up in the last 24 hours; each row below
          shows why, with Retry fetch.
        </p>
      ) : null}

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Parsing</span>
          <select
            name="parsing"
            defaultValue={sp.parsing ?? ""}
            className="rounded-md border border-neutral-300 px-2 py-1"
          >
            <option value="">any</option>
            <option value="matched">matched</option>
            <option value="unmatched">unmatched</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">From</span>
          <input
            type="date"
            name="from"
            defaultValue={sp.from ?? ""}
            className="rounded-md border border-neutral-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">To</span>
          <input
            type="date"
            name="to"
            defaultValue={sp.to ?? ""}
            className="rounded-md border border-neutral-300 px-2 py-1"
          />
        </label>
        <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white">
          Filter
        </button>
        {(sp.parsing || sp.from || sp.to) && (
          <Link
            href="/admin/whatsapp-log"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 hover:bg-neutral-50"
          >
            Reset
          </Link>
        )}
      </form>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">Caption</th>
              <th className="px-3 py-2">Parsed context</th>
              <th className="px-3 py-2">Submission</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Resend</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                  No WhatsApp ingest events match the current filter.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const phone = phoneBySubmissionId.get(r.id) ?? "—";
                const caption = (r.captionRaw ?? "").trim();
                const captionShort = caption.length > 40 ? `${caption.slice(0, 40)}…` : caption || "—";
                // No bytes in Storage yet (or ever): a transcode has nothing to
                // read, so the row offers the fetch again instead -- when the
                // media id was kept (every row since migration 0036).
                const awaitingMedia = r.fileStatus !== "stored";
                const canRetryFetch = awaitingMedia && r.mediaId !== null;
                const canResend = !awaitingMedia && RESENDABLE_STATUSES.has(r.status);
                const why =
                  r.status === "failed" ? r.processingLog : awaitingMedia ? r.fetchError : null;
                const parsing = parsingLabel(r.contextType);
                return (
                  <tr key={r.id} className="border-t border-neutral-100">
                    <td className="px-3 py-2 text-xs">
                      {r.createdAt?.toISOString().slice(0, 19).replace("T", " ") ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{phone}</td>
                    <td className="px-3 py-2 text-xs" title={caption}>
                      {captionShort}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={chipForContext(r.contextType)}>
                        {parsing} · {r.contextType.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <Link
                        href={`/videos/${r.id}`}
                        className="font-mono text-neutral-700 underline hover:text-neutral-900"
                      >
                        {r.id.slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>
                        {awaitingMedia && r.status === "received" ? "awaiting media" : r.status}
                      </span>
                      {why ? (
                        <div className="mt-1 max-w-xs break-words text-[11px] text-rust" data-testid="ingest-error">
                          {why.length > 200 ? `${why.slice(0, 200)}…` : why}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {canRetryFetch ? (
                        <form action={retryWhatsAppFetchAction}>
                          <input type="hidden" name="submissionId" value={r.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50"
                          >
                            Retry fetch
                          </button>
                        </form>
                      ) : canResend ? (
                        <form action={resendTranscodeAction}>
                          <input type="hidden" name="submissionId" value={r.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50"
                          >
                            Resend transcode
                          </button>
                        </form>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-400">
        Showing the most recent {PAGE_LIMIT} WhatsApp submissions. For
        full WhatsApp audit-trail history (parse failures, signature
        rejections, media-fetch errors) see{" "}
        <Link href="/admin/audit" className="underline">
          /admin/audit
        </Link>
        .
      </p>
    </main>
  );
}
