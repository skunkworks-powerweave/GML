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
import { z } from "zod";
import { db } from "@gml/db";
import {
  files,
  videoSubmissions,
  observationCycles,
  mentorMeetings,
  mentorPairings,
  users,
  teachers,
} from "@gml/db/schema";
import { enqueue } from "@gml/db/queue";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { maskIp, recordAudit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom, UNKNOWN_IP } from "@/lib/request-ip";
import { cycleVisibility, pairingVisibility, type Actor } from "@/lib/visibility";
import { parseCaption } from "@gml/shared/whatsapp/caption";
import {
  WHATSAPP_FETCH_JOB,
  WHATSAPP_FETCH_MAX_ATTEMPTS,
  WHATSAPP_QUEUE,
  WHATSAPP_REPLY_JOB,
  whatsappFetchDedupeKey,
  type WhatsAppFetchPayload,
  type WhatsAppReplyPayload,
} from "@gml/shared/whatsapp/fetch-job";
import { replyText } from "@gml/shared/whatsapp/replies";

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
  // Meta's handshake used to be refused with nothing in the logs when the
  // variable was simply missing, which reads exactly like Meta never calling.
  if (mode === "subscribe" && !process.env.WHATSAPP_VERIFY_TOKEN) warnVerifyTokenUnsetOnce();
  return NextResponse.json({ error: "verify_failed" }, { status: 403 });
}

let warnedVerifyToken = false;
function warnVerifyTokenUnsetOnce(): void {
  if (warnedVerifyToken) return;
  warnedVerifyToken = true;
  console.warn(
    "[whatsapp] refused Meta's webhook verification: WHATSAPP_VERIFY_TOKEN is not set. Set it to the " +
      "verify token typed into the Meta dashboard (see README-IT.md, \"WhatsApp Business setup\").",
  );
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

  // No signature header: refused before the body is read, since there is
  // nothing to verify it against.
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const raw = signature ? await req.text() : "";
  if (!signature || !verifySignature(raw, signature)) {
    await auditSignatureFailure(req, signature !== "");
    return NextResponse.json({ error: "signature_failed" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  // CHECKED, not cast. `JSON.parse(raw) as WhatsAppPayload` let a signed body
  // of `null`, `entry: 5` or `messages: {}` throw a TypeError into a 500, and
  // Meta retries a 5xx indefinitely. Only Meta can sign, so an unexpected
  // shape means its schema moved: record it and answer 200, because a retry
  // cannot make this code understand it.
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) {
    recordUnrecognised(raw.length, "payload", parsed.error.issues[0]?.path ?? []);
    return NextResponse.json({ ok: true, unrecognised: true });
  }
  const body = parsed.data;

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
        for (const [index, candidate] of (change.value?.messages ?? []).entries()) {
          // Per message, so one malformed entry does not take the valid videos
          // in the same batch down with it.
          const checked = MessageSchema.safeParse(candidate);
          if (!checked.success) {
            recordUnrecognised(raw.length, `message[${index}]`, checked.error.issues[0]?.path ?? []);
            continue;
          }
          const msg = checked.data;
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
            await answerIgnored(msg);
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

// The parts of Meta's payload this route reads, and nothing more. Permissive by
// design (.passthrough(), everything optional that Meta does not always send):
// a new field from Meta must not make a delivery unreadable. `messages` is
// checked one element at a time in POST.
const MediaSchema = z
  .object({
    id: z.string().min(1),
    mime_type: z.string().optional(),
    caption: z.string().optional(),
    sha256: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();

const MessageSchema = z
  .object({
    type: z.string(),
    from: z.string(),
    id: z.string().min(1),
    timestamp: z.string().optional(),
    video: MediaSchema.optional(),
    document: MediaSchema.optional(),
  })
  .passthrough();

const PayloadSchema = z
  .object({
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    value: z
                      .object({
                        metadata: z.object({ display_phone_number: z.string().optional() }).passthrough().optional(),
                        messages: z.array(z.unknown()).optional(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

type WhatsAppMessage = z.infer<typeof MessageSchema>;

/** A signed delivery, or one message in it, that this code cannot read. */
function recordUnrecognised(bytes: number, where: string, path: Array<string | number>): void {
  console.warn(`[whatsapp] unrecognised ${where} in a signed delivery (at ${path.join(".") || "root"}); answered 200`);
  void recordAudit({
    action: "whatsapp.payload.unrecognised",
    entityType: "webhook",
    metadata: { bytes, where, path: path.join(".") },
  });
}

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

/**
 * Kinds of message a person sends when they are trying to submit something.
 * Reactions, system notices and the like get no answer: replying "this number
 * accepts lesson videos" to a thumbs-up on our own reply would be noise.
 */
const ANSWERED_TYPES = new Set(["text", "image", "audio", "document", "sticker"]);

/**
 * Queue the reply that tells the sender this number takes videos (F140). The
 * sender used to hear nothing, ever. Queued, not sent here: the request stays
 * database-only, and the reply survives a restart. One per message id.
 */
async function answerIgnored(msg: WhatsAppMessage): Promise<void> {
  if (!msg.from || !msg.id || !ANSWERED_TYPES.has(msg.type)) return;
  const payload: WhatsAppReplyPayload = { msgId: msg.id, to: msg.from, body: replyText({ kind: "not_a_video" }) };
  await enqueue(db as unknown as NodePgDatabase<Record<string, unknown>>, {
    queue: WHATSAPP_QUEUE,
    name: WHATSAPP_REPLY_JOB,
    payload: payload as unknown as Record<string, unknown>,
    dedupeKey: `reply:${msg.id}`,
    maxAttempts: 1,
  });
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
  const sender = await resolveSender(msg.from);
  const submittedByUserId = sender?.id ?? null;

  // AUTHORISATION. The signature proves Meta delivered this, not who sent it,
  // and the caption is the sender's claim about where it goes. Routing on the
  // caption alone let anyone attach a clip to any teacher's cycle (codes are
  // sequential) or any meeting, where authz then showed it to that cycle's
  // teacher, observer and mentors; and it let a teacher who mistyped a code
  // send her classroom to someone else's. The direct upload path has always
  // refused this (uploads/actions.ts, assertContextAllowed); this applies the
  // same visibility rules lib/authz.ts uses. A refused or unattributable clip
  // is still ingested, as 'generic' -- admin-and-sender only -- with the
  // caption kept, so nothing is lost and an admin can attach it.
  if (contextType !== "generic") {
    const refusal = await refusalFor(sender, contextType, contextId);
    if (refusal) {
      void recordAudit({
        action: "whatsapp.context.forbidden",
        entityType: "video_submission",
        metadata: {
          msgId: msg.id,
          caption,
          from: msg.from,
          senderUserId: sender?.id ?? null,
          attemptedContextType: contextType,
          attemptedContextId: contextId,
          reason: refusal,
        },
      });
      contextType = "generic";
      contextId = null;
    }
  }

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
 *
 * Returns the role too, because the answer now also decides what the sender may
 * attach the video to (refusalFor). For the same reason a database error is no
 * longer swallowed into "nobody": that would quietly quarantine a real
 * teacher's video. It propagates, the webhook answers 500, and Meta redelivers.
 */
async function resolveSender(from: string): Promise<Actor | null> {
  const digits = (from ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const tail = "%" + digits.slice(-10);
  const rows = await db
    .selectDistinct({ id: users.id, role: users.role })
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
  return rows.length === 1 ? { id: rows[0]!.id, role: rows[0]!.role } : null;
}

/**
 * Why this sender may NOT attach a video to this target, or null if they may.
 *
 * The same rules as the rest of the app, through the same predicates
 * (lib/visibility.ts, which lib/authz.ts binds):
 *
 *   observation_cycle  the cycle's teacher or observer, a mentor actively
 *                      paired with its teacher, or an admin
 *   mentor_meeting     a member of the meeting's pairing, or an admin
 *   teach_back         any registered sender. A teach-back is the uploader's
 *                      own work and has no owning row to check -- the upload
 *                      path accepts it from any signed-in user the same way.
 *
 * An unrecognised number may attach to nothing: without a sender there is no
 * one to check, and a stranger's clip must not reach a cycle's reviewers or
 * every mentor's teach-back queue.
 */
async function refusalFor(
  sender: Actor | null,
  contextType: "observation_cycle" | "teach_back" | "mentor_meeting",
  contextId: string | null,
): Promise<string | null> {
  if (!sender) return "sender_unregistered";
  if (!contextId) return "no_target";
  if (contextType === "teach_back") return null;
  if (contextType === "observation_cycle") {
    const [ok] = await db
      .select({ id: observationCycles.id })
      .from(observationCycles)
      .where(and(eq(observationCycles.id, contextId), await cycleVisibility(db, sender)))
      .limit(1);
    return ok ? null : "observation_cycle.not_permitted";
  }
  const [ok] = await db
    .select({ id: mentorMeetings.id })
    .from(mentorMeetings)
    .innerJoin(mentorPairings, eq(mentorPairings.id, mentorMeetings.pairingId))
    .where(and(eq(mentorMeetings.id, contextId), await pairingVisibility(db, sender)))
    .limit(1);
  return ok ? null : "mentor_meeting.not_permitted";
}


/**
 * Signature failures audited per source per minute, at most.
 *
 * This endpoint is public by necessity and audit_log is append-only by trigger
 * (_post/001), so a row per failed POST let any script on the internet grow
 * the one table nobody can clean, and bury the events /admin/audit exists to
 * show. Meta signs everything it sends, so a legitimate delivery never lands
 * here; a handful of rows per source per minute is enough to see an attack, or
 * a wrongly configured secret, without letting either write gigabytes.
 */
const SIGNATURE_FAILURE_AUDITS_PER_MINUTE = 5;

/**
 * Record a failed signature -- a bounded number of times per masked source
 * (the /24, or the /64 for IPv6), counted atomically in rate_limits so a
 * concurrent burst cannot slip past the way a read-then-insert dedup would.
 * The rows now say where the failures came from and whether a signature was
 * even offered, which docs/audit-actions.md promised and nothing wrote.
 */
async function auditSignatureFailure(req: Request, signatureProvided: boolean): Promise<void> {
  const ip = clientIpFrom(req.headers);
  const ipMasked = maskIp(ip === UNKNOWN_IP ? undefined : ip) ?? "unknown";
  try {
    const slot = await rateLimit({
      bucket: "wa-sig-audit",
      id: ipMasked,
      limit: SIGNATURE_FAILURE_AUDITS_PER_MINUTE,
      windowMs: 60_000,
    });
    if (!slot.ok) return;
  } catch (err) {
    // The request is refused either way; a counter we cannot reach must not
    // turn into an unbounded write.
    console.error("[whatsapp] signature-failure counter unavailable; not auditing this one", err);
    return;
  }
  void recordAudit({
    action: "whatsapp.signature_failed",
    entityType: "webhook",
    metadata: { ipMasked, signatureProvided },
  });
  // A WRONG secret made every real delivery a 401 and printed nothing; the one
  // log line the troubleshooting tables pointed at is printed only when the
  // secret is UNSET. Bounded by the same counter as the audit row.
  if (signatureProvided) {
    console.warn(
      `[whatsapp] signature check failed for a POST from ${ipMasked}. If this is Meta, ` +
        "WHATSAPP_APP_SECRET does not match the app secret in the Meta dashboard (App settings > Basic).",
    );
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
