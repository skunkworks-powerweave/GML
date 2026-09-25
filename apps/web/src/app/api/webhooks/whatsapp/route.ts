// WhatsApp Business Cloud API webhook — PRIMARY teacher upload path.
//
// Flow:
//   1. Teacher sends a video to the GML number with a caption like
//      `OBS-2026-001` (observation cycle) or `TB-<uuid>` (teach-back). A video
//      attached through WhatsApp's Document picker counts too.
//   2. Meta calls this webhook with the message metadata.
//   3. We verify the signature, work out which cycle / teach-back / meeting the
//      caption names, and -- in ONE transaction -- insert the files row
//      (status 'uploading'), the video_submissions row (status 'received',
//      with the Graph media id and the sender) and a 'whatsapp_fetch' job on
//      the Postgres queue. Only then is Meta told 200.
//   4. The worker (apps/worker/src/whatsapp-fetch.ts) claims the job, fetches
//      the media from the Graph API, stores it, and queues the transcode. A
//      failure there is retried with backoff and, if it never succeeds, marks
//      the submission failed with the reason and shows on /admin/whatsapp-log.
//   5. Once transcoded, the row moves to status='ready' and the teacher's
//      cycle/teach-back drill-in shows the playable HLS link.
//
// Meta deletes media about 30 days after delivery, so the fetch is queued at
// once and the media id is kept for a retry inside that window.

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@gml/db";
import {
  files,
  videoSubmissions,
  observationCycles,
  mentorMeetings,
  users,
  teachers,
} from "@gml/db/schema";
import { enqueue } from "@gml/db/queue";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { recordAudit } from "@/lib/audit";
import { parseCaption } from "@gml/shared/whatsapp/caption";
import {
  WHATSAPP_FETCH_JOB,
  WHATSAPP_FETCH_MAX_ATTEMPTS,
  WHATSAPP_QUEUE,
  whatsappFetchDedupeKey,
  type WhatsAppFetchPayload,
} from "@gml/shared/whatsapp/fetch-job";

// Caption-format UUID validator. TB-<uuid> and MM-<uuid> branches require a
// canonical lowercase-or-uppercase 8-4-4-4-12 hex group; anything else falls
// through to the generic context_type so audit + ops can see the raw caption.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// GET handler: Meta verifies the webhook URL on initial setup
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "verify_failed" }, { status: 403 });
}

// POST handler: actual message ingestion
export async function POST(req: Request) {
  // NOT CONFIGURED is its own answer. WhatsApp is switched on after go-live, so
  // the LMS legitimately runs without a secret; every request is refused (the
  // route fails closed), but it is not a signature failure -- there is nothing
  // to verify against -- so it is neither a 401 nor an audit row per stray POST
  // into the append-only log. One log line per process says why.
  if (!process.env.WHATSAPP_APP_SECRET) {
    warnUnconfiguredOnce();
    return NextResponse.json({ error: "whatsapp_not_configured" }, { status: 503 });
  }

  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!verifySignature(raw, signature)) {
    void recordAudit({ action: "whatsapp.signature_failed", entityType: "webhook" });
    return NextResponse.json({ error: "signature_failed" }, { status: 401 });
  }

  let body: WhatsAppPayload;
  try {
    body = JSON.parse(raw) as WhatsAppPayload;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Meta sends a batch of "entry" -> "changes" -> "value" -> "messages".
  //
  // ACCEPT DURABLY, THEN ANSWER. Each video becomes a submission row and a
  // queued fetch job BEFORE the 200 (acceptVideoMessage). This used to be the
  // other way round: the whole ingest ran in after(), once Meta had its 200,
  // and Meta redelivers only a webhook that did NOT get a 2xx -- so a blank or
  // expired access token, a Graph or Storage error, or a restart mid-ingest
  // lost the video for good, with nothing recorded to fetch it again.
  //
  // What stays in the request is database work only, so the answer is still
  // quick; the slow part (the Graph download) is in the worker, which is why
  // this handler cannot hit Meta's ~20 s timeout the way the old in-request
  // fetch did.
  //
  // If the database write fails, the answer is a 500 and Meta redelivers.
  // Messages earlier in the same batch that were already accepted are then
  // replays: the pre-check and the unique index on whatsapp_message_id make a
  // second delivery a no-op.
  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          const phone = change.value?.metadata?.display_phone_number;
          const media = inboundVideo(msg);
          if (!media) {
            // Anything that is not a video is not ingested -- but it is not
            // dropped without trace either, which is what `continue` did.
            void recordAudit({
              action: "whatsapp.message.ignored",
              entityType: "webhook",
              metadata: {
                msgId: msg.id,
                type: msg.type,
                mime: msg.document?.mime_type ?? null,
                from: msg.from,
                to: phone,
              },
            });
            continue;
          }
          await acceptVideoMessage(msg, media, phone);
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp] could not record an inbound message; answering 500 so Meta redelivers", err);
    return NextResponse.json({ error: "ingest_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

type MediaObject = { id: string; mime_type?: string; caption?: string; sha256?: string; filename?: string };

type WhatsAppMessage = {
  type: string;
  from: string;
  id: string;
  timestamp: string;
  video?: MediaObject;
  document?: MediaObject;
};

type WhatsAppPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { display_phone_number?: string };
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
};

/** The media a message carries, when that media is a video. */
type InboundVideo = { mediaId: string; mimeType: string; caption: string; sha256: string | null };

/**
 * The video in a message, whichever WhatsApp picker sent it.
 *
 * Meta caps a VIDEO message at 16 MB and recompresses it. A classroom lesson is
 * far bigger, so WhatsApp makes the teacher send it as a DOCUMENT (up to 100
 * MB, uncompressed), and many send that way on purpose to keep the quality.
 * Those arrive as type 'document' with a video/* mime type, and the old
 * `msg.type !== "video"` filter skipped every one of them before any audit row
 * was written. A document that is not a video (a PDF lesson plan) is still not
 * a submission.
 */
function inboundVideo(msg: WhatsAppMessage): InboundVideo | null {
  const media =
    msg.type === "video"
      ? msg.video
      : msg.type === "document" && /^video\//i.test(msg.document?.mime_type ?? "")
        ? msg.document
        : undefined;
  if (!media?.id) return null;
  return {
    mediaId: media.id,
    mimeType: media.mime_type || "video/mp4",
    caption: (media.caption ?? "").trim(),
    sha256: media.sha256 ?? null,
  };
}

/** A concurrent delivery of the same message won the insert. */
class ReplayLost extends Error {}

async function acceptVideoMessage(
  msg: WhatsAppMessage,
  media: InboundVideo,
  recipientPhone?: string,
): Promise<void> {
  void recordAudit({
    action: "whatsapp.message.received",
    entityType: "video_submission",
    metadata: {
      msgId: msg.id,
      type: msg.type,
      mediaId: media.mediaId,
      mime: media.mimeType,
      caption: media.caption,
      from: msg.from,
      to: recipientPhone,
    },
  });

  // Spec 144 — idempotency pre-check. Meta's webhook uses at-least-once
  // delivery; the same msg.id arrives 2-3 times when our 200 is delayed.
  // Without this guard we'd insert 2-3 video_submissions rows + enqueue
  // 2-3 transcode jobs running ffmpeg in parallel. The DB-side partial
  // UNIQUE INDEX (migration 0017) is the belt; this SELECT is the
  // suspenders — it lets us return a clean 200 and audit the replay so
  // ops sees the retry pattern instead of an ON CONFLICT noise spike.
  const existing = await db
    .select({ id: videoSubmissions.id })
    .from(videoSubmissions)
    .where(eq(videoSubmissions.whatsappMessageId, msg.id))
    .limit(1);
  if (existing.length > 0) {
    void recordAudit({
      action: "whatsapp.message.replay_ignored",
      entityType: "video_submission",
      entityId: existing[0].id,
      metadata: { msgId: msg.id, from: msg.from, to: recipientPhone },
    });
    return;
  }

  // Parse the caption to determine context (OBS- / TB- / MM-, anywhere in the
  // caption, any case; see packages/shared/src/whatsapp/caption.ts). The media
  // itself is fetched by the worker, after this request has recorded
  // everything needed to do so.
  const caption = media.caption;
  const ctx = parseCaption(caption);

  // Resolve context_id by looking up the parent entity using the caption
  // prefix. Each branch falls through to 'generic' on lookup failure so a
  // typo never blocks the upload -- the raw caption is kept on the submission
  // (caption_raw) and the unmatched case is audited as
  // whatsapp.context.unmatched, so an operator can find and re-link it.
  let contextType: "observation_cycle" | "teach_back" | "mentor_meeting" | "generic" = ctx.type;
  let contextId: string | null = null;

  if (ctx.type === "observation_cycle" && ctx.code) {
    const [cycle] = await db
      .select({ id: observationCycles.id })
      .from(observationCycles)
      // Either convention: the column stores "OBS-2026-004" today, and a
      // future import might store "2026-004". Neither should silently miss --
      // and neither should "obs-2026-004" typed on a phone.
      .where(
        sql`upper(${observationCycles.code}) IN (upper(${ctx.fullCode ?? ctx.code}), upper(${ctx.code}))`,
      )
      .limit(1);
    if (cycle?.id) {
      contextId = cycle.id;
    } else {
      contextType = "generic";
      void recordAudit({
        action: "whatsapp.context.unmatched",
        entityType: "video_submission",
        metadata: { msgId: msg.id, caption, reason: "observation_cycle.code_not_found" },
      });
    }
  } else if (ctx.type === "teach_back" && ctx.code) {
    if (UUID_RE.test(ctx.code)) {
      // We accept the caption-supplied uuid as the teach_back id. The
      // teach_backs surface (spec 066) is the source of truth for the id
      // namespace; no FK exists on video_submissions.context_id by design.
      contextId = ctx.code;
    } else {
      contextType = "generic";
      void recordAudit({
        action: "whatsapp.context.unmatched",
        entityType: "video_submission",
        metadata: { msgId: msg.id, caption, reason: "teach_back.invalid_uuid" },
      });
    }
  } else if (ctx.type === "mentor_meeting" && ctx.code) {
    if (UUID_RE.test(ctx.code)) {
      const [mtg] = await db
        .select({ id: mentorMeetings.id })
        .from(mentorMeetings)
        .where(eq(mentorMeetings.id, ctx.code))
        .limit(1);
      if (mtg?.id) {
        contextId = mtg.id;
      } else {
        contextType = "generic";
        void recordAudit({
          action: "whatsapp.context.unmatched",
          entityType: "video_submission",
          metadata: { msgId: msg.id, caption, reason: "mentor_meeting.id_not_found" },
        });
      }
    } else {
      contextType = "generic";
      void recordAudit({
        action: "whatsapp.context.unmatched",
        entityType: "video_submission",
        metadata: { msgId: msg.id, caption, reason: "mentor_meeting.invalid_uuid" },
      });
    }
  } else if (ctx.type === "generic") {
    // Caption didn't match any known prefix — record it so ops can see
    // what teachers are actually sending.
    void recordAudit({
      action: "whatsapp.context.unmatched",
      entityType: "video_submission",
      metadata: { msgId: msg.id, caption, reason: "no_prefix_match" },
    });
  }

  // ATTRIBUTION. `submitted_by_user_id` had no writer anywhere in the codebase,
  // so every dashboard count and the "my uploads" badge that join through it
  // were permanently zero for the PRIMARY ingest path -- and lib/authz.ts's
  // "you uploaded it" branch could never match for a WhatsApp video.
  //
  // WhatsApp gives us the sender's phone number and nothing else, so this is a
  // best-effort match against users.phone. An unmatched sender leaves the
  // column null, exactly as before -- the submission is still ingested, because
  // refusing video from a teacher whose phone number has a different format on
  // file would lose programme evidence to a data-entry mismatch.
  const submittedByUserId = await resolveSenderUserId(msg.from);

  // THE DURABLE RECORD: file, submission and fetch job, in one transaction, so
  // there is never a submission with no job to fetch it or a job with no row
  // to fill. The transcode is queued by the worker once the bytes are stored;
  // queueing it here would transcode an object that does not exist yet.
  const objectKey = `whatsapp/${msg.id}.mp4`;
  let accepted: { submissionId: string; jobId: string };
  try {
    accepted = await db.transaction(async (tx) => {
      // An upsert, not a plain insert. The key is derived from the message id,
      // and the previous ingest wrote the files row and the submission in two
      // separate statements; one that failed between them left a files row
      // with no submission, and a plain insert would have turned every
      // redelivery of that message into a unique violation. A concurrent
      // duplicate delivery is still stopped below, at the submission insert,
      // which rolls this back with it.
      const [fileRow] = await tx
        .insert(files)
        .values({
          bucket: BUCKETS.videosOriginal,
          objectKey,
          mimeType: media.mimeType,
          checksumSha256: media.sha256,
          kind: "video_original",
          status: "uploading",
        })
        .onConflictDoUpdate({
          target: [files.bucket, files.objectKey],
          set: { status: "uploading", mimeType: media.mimeType, checksumSha256: media.sha256 },
        })
        .returning({ id: files.id });

      // Spec 144 — whatsapp_message_id set on insert, and the partial unique
      // index is the arbiter when two concurrent Meta retries both pass the
      // pre-check above.
      const inserted = await tx
        .insert(videoSubmissions)
        .values({
          fileId: fileRow!.id,
          source: "whatsapp",
          status: "received",
          contextType,
          contextId,
          captionRaw: caption,
          whatsappMessageId: msg.id,
          whatsappMediaId: media.mediaId,
          whatsappFrom: msg.from,
          submittedByUserId,
        })
        .onConflictDoNothing({
          target: videoSubmissions.whatsappMessageId,
          where: isNotNull(videoSubmissions.whatsappMessageId),
        })
        .returning({ id: videoSubmissions.id });
      const sub = inserted[0];
      if (!sub) throw new ReplayLost();

      const payload: WhatsAppFetchPayload = {
        msgId: msg.id,
        videoSubmissionId: sub.id,
        fileId: fileRow!.id,
        bucket: BUCKETS.videosOriginal,
        objectKey,
        mediaId: media.mediaId,
        mimeType: media.mimeType,
        sha256: media.sha256,
        from: msg.from,
      };
      const job = await enqueue(tx as unknown as NodePgDatabase<Record<string, unknown>>, {
        queue: WHATSAPP_QUEUE,
        name: WHATSAPP_FETCH_JOB,
        payload: payload as unknown as Record<string, unknown>,
        dedupeKey: whatsappFetchDedupeKey(msg.id),
        maxAttempts: WHATSAPP_FETCH_MAX_ATTEMPTS,
      });
      return { submissionId: sub.id, jobId: job.id };
    });
  } catch (err) {
    if (!(err instanceof ReplayLost)) throw err;
    // Lost the race against a concurrent Meta retry, which recorded the row and
    // queued the fetch itself; this attempt changed nothing.
    void recordAudit({
      action: "whatsapp.message.replay_ignored",
      entityType: "video_submission",
      metadata: { msgId: msg.id, reason: "insert_conflict" },
    });
    return;
  }

  void recordAudit({
    action: "whatsapp.fetch.enqueued",
    entityType: "video_submission",
    entityId: accepted.submissionId,
    metadata: { msgId: msg.id, mediaId: media.mediaId, jobId: accepted.jobId, contextType },
  });
}

/**
 * Verify Meta's HMAC over the RAW body.
 *
 * FAILS CLOSED when WHATSAPP_APP_SECRET is unset. It used to return `true` with
 * a console.warn, which meant that on any deployment where the variable was
 * missing -- and it was absent from .env.example entirely, so that was every
 * deployment -- ANY anonymous caller who could reach this URL could inject
 * video_submissions rows, attach them to a real observation cycle by caption,
 * and have the worker fetch arbitrary URLs.
 *
 * This is the PRIMARY ingest path for the product and it is internet-facing by
 * necessity. "Accept everything when unconfigured" is not a dev convenience
 * here; it is the default configuration.
 */
/**
 * Map a WhatsApp sender to an LMS user by phone number.
 *
 * Matching is on the last 10 digits. Meta delivers E.164 without a leading "+"
 * (e.g. 919419123456) while numbers on file are entered by administrators in
 * whatever shape the teacher gave them -- "+91 94191 23456", "094191 23456",
 * "9419123456". Comparing the full string would match almost nothing; the last
 * 10 digits are the subscriber number for every Indian mobile.
 *
 * Returns null when there is no match OR when there is more than one: an
 * ambiguous match must not attribute a classroom recording to the wrong
 * teacher, and null is the honest answer.
 */
/**
 * Which user sent this video?
 *
 * WhatsApp gives us a phone number and nothing else, so this is a best-effort
 * match. An unmatched sender leaves submitted_by_user_id null and the
 * submission is still ingested -- refusing a teacher's video over a data-entry
 * mismatch would lose programme evidence.
 *
 * ── WHY IT ALSO LOOKS AT teachers.phone ─────────────────────────────────────
 *
 * It used to match users.phone ALONE, and in the live database that column is
 * empty for every row:
 *
 *     users     total 1   with_phone 0
 *     teachers  total 10  with_phone 10
 *
 * Phone numbers are entered against TEACHERS -- that is where the seed puts
 * them, and /admin/data/teachers is the only surface that edits one. There is
 * no users entity in the admin registry and /admin/users has no phone field,
 * so users.phone cannot be populated through the product at all.
 *
 * The result was that every inbound WhatsApp video -- the programme's PRIMARY
 * ingest path -- would have been attributed to nobody, no matter how correctly
 * Meta was configured. The uploader's own "my uploads" and every dashboard
 * count that joins through submitted_by_user_id would have stayed at zero
 * while the videos arrived perfectly well.
 *
 * Matching through teachers.user_id uses the data that is already there, in
 * the place an administrator would naturally put it.
 *
 * Still deliberately conservative: the last ten digits (so +91 99999 11111,
 * 09999911111 and 919999911111 all agree), active and non-deleted users only,
 * and a match is accepted ONLY when exactly one user answers to that number.
 * Two people sharing a handset attributes to neither rather than to the wrong
 * one.
 */
async function resolveSenderUserId(from: string): Promise<string | null> {
  const digits = (from ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const tail = "%" + digits.slice(-10);
  try {
    const rows = await db
      .selectDistinct({ id: users.id })
      .from(users)
      .leftJoin(teachers, eq(teachers.userId, users.id))
      .where(
        and(
          eq(users.active, true),
          isNull(users.deletedAt),
          or(
            sql`regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g') LIKE ${tail}`,
            sql`regexp_replace(coalesce(${teachers.phone}, ''), '[^0-9]', '', 'g') LIKE ${tail}`,
          ),
        ),
      )
      .limit(2);
    return rows.length === 1 ? rows[0]!.id : null;
  } catch {
    return null;
  }
}


let warnedUnconfigured = false;
function warnUnconfiguredOnce(): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  console.warn(
    "[whatsapp] WHATSAPP_APP_SECRET is not set — the webhook refuses all traffic and WhatsApp " +
      "ingest is OFF. Set the WHATSAPP_* variables (see .env.example) to switch it on.",
  );
}

function verifySignature(raw: string, signatureHeader: string): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  // Still fails closed on its own, whoever calls it.
  if (!secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  if (signatureHeader.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}
