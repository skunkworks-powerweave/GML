// WhatsApp Business Cloud API webhook — PRIMARY teacher upload path.
//
// Flow:
//   1. Teacher sends a video to the GML number with a caption like
//      `OBS-2026-001` (observation cycle) or `TB-eng-grade5` (teach-back).
//   2. Meta calls this webhook with the message metadata.
//   3. We verify the signature, fetch the media via Graph API, store it to
//      MinIO, create video_submissions row with source='whatsapp', then
//      enqueue a the job queue transcode_jobs row (spec 039 + 040).
//   4. Once transcoded, the row moves to status='ready' and the teacher's
//      cycle/teach-back drill-in shows the playable HLS link.
//
// Meta deletes media 30 days after delivery, so we fetch immediately and
// retain our copy.

import { NextResponse, after } from "next/server";
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
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { storage, BUCKETS } from "@/lib/video/storage";
import { recordAudit } from "@/lib/audit";
import { enqueueTranscode } from "@/lib/queue";

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
  // The ingest runs in `after()`, so this handler returns 200 immediately and
  // the media fetch happens once the response is on the wire. Meta times a
  // webhook out at roughly 20 seconds and RETRIES on timeout; fetching a video
  // from the Graph API and uploading it to Storage inside the request meant a
  // slow link produced duplicate deliveries of work that was already in flight.
  //
  // Duplicates are still possible -- Meta can retry for reasons of its own --
  // and remain harmless: ingestVideoMessage pre-checks whatsappMessageId and
  // the insert carries onConflictDoNothing against the partial unique index,
  // so the second delivery is audited as a replay and does nothing.
  const pending: Array<() => Promise<void>> = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== "video") continue;
        const phone = change.value?.metadata?.display_phone_number;
        pending.push(() => ingestVideoMessage(msg, phone));
      }
    }
  }

  if (pending.length > 0) {
    after(async () => {
      for (const run of pending) {
        try {
          await run();
        } catch (err) {
          // after() work has no response to fail; log loudly so an operator can
          // find it, and let the remaining messages in the batch proceed.
          console.error("[whatsapp] ingest failed after response", err);
        }
      }
    });
  }

  return NextResponse.json({ ok: true });
}

type WhatsAppPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { display_phone_number?: string };
        messages?: Array<{
          type: string;
          from: string;
          id: string;
          timestamp: string;
          video?: { id: string; mime_type: string; caption?: string; sha256?: string };
        }>;
      };
    }>;
  }>;
};

async function ingestVideoMessage(
  msg: NonNullable<NonNullable<NonNullable<WhatsAppPayload["entry"]>[number]["changes"]>[number]["value"]>["messages"] extends (infer M)[] | undefined ? M : never,
  recipientPhone?: string,
): Promise<void> {
  if (!msg.video) return;
  void recordAudit({
    action: "whatsapp.message.received",
    entityType: "video_submission",
    metadata: { msgId: msg.id, mime: msg.video.mime_type, caption: msg.video.caption, from: msg.from, to: recipientPhone },
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

  // 1. Fetch the media URL from Graph API
  const mediaUrl = await fetchMediaUrl(msg.video.id);
  if (!mediaUrl) {
    void recordAudit({ action: "whatsapp.media.url_failed", entityType: "video_submission", metadata: { msgId: msg.id } });
    return;
  }

  // 2. Download the bytes
  const bytes = await downloadMediaBytes(mediaUrl);
  if (!bytes) {
    void recordAudit({ action: "whatsapp.media.fetch_failed", entityType: "video_submission", metadata: { msgId: msg.id } });
    return;
  }
  void recordAudit({
    action: "whatsapp.media.fetched",
    entityType: "video_submission",
    metadata: { msgId: msg.id, bytes: bytes.byteLength },
  });

  // 3. Parse caption to determine context
  const caption = (msg.video.caption ?? "").trim();
  const ctx = parseCaption(caption);

  // 4. Store original to MinIO
  const objectKey = `whatsapp/${msg.id}.mp4`;
  await storage.put(BUCKETS.videosOriginal, objectKey, bytes, msg.video.mime_type ?? "video/mp4");

  // 5. Insert files + video_submissions rows
  const [fileRow] = await db
    .insert(files)
    .values({
      bucket: BUCKETS.videosOriginal,
      objectKey,
      mimeType: msg.video.mime_type ?? "video/mp4",
      sizeBytes: bytes.byteLength,
      checksumSha256: msg.video.sha256,
      kind: "video_original",
      status: "stored",
    })
    .returning({ id: files.id });

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
      // future import might store "2026-004". Neither should silently miss.
      .where(
        or(
          eq(observationCycles.code, ctx.fullCode ?? ctx.code),
          eq(observationCycles.code, ctx.code),
        ),
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

  // Spec 144 — set whatsapp_message_id on insert and gracefully handle the
  // race where two concurrent Meta retries pass the pre-check (above) but
  // only one wins at the DB layer. onConflictDoNothing leaves the index as
  // the sole arbiter; the loser path returns no rows and we audit it as a
  // replay too. Downstream transcode enqueue only fires when sub is defined.
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

  const inserted = await db
    .insert(videoSubmissions)
    .values({
      fileId: fileRow.id,
      source: "whatsapp",
      status: "received",
      contextType,
      contextId,
      captionRaw: caption,
      whatsappMessageId: msg.id,
      submittedByUserId,
    })
    .onConflictDoNothing({
      target: videoSubmissions.whatsappMessageId,
      where: isNotNull(videoSubmissions.whatsappMessageId),
    })
    .returning({ id: videoSubmissions.id });

  const sub = inserted[0];
  if (!sub) {
    // Lost the race against a concurrent Meta retry. The other request
    // already inserted the row and enqueued the transcode; we just audit
    // and return so this attempt is a true no-op.
    void recordAudit({
      action: "whatsapp.message.replay_ignored",
      entityType: "video_submission",
      metadata: { msgId: msg.id, reason: "insert_conflict" },
    });
    return;
  }

  // 6. Enqueue the transcode. The worker claims it from the jobs table, runs
  //    ffmpeg -> HLS 480p, uploads to Storage, then flips the submission to
  //    'ready'.
  //
  //    Deduped on the submission id: Meta re-delivers a webhook it believes
  //    timed out, and this handler is deliberately not fast.
  await enqueueTranscode({
    videoSubmissionId: sub.id,
    fileId: fileRow.id,
    bucket: BUCKETS.videosOriginal,
    objectKey,
  });
  void recordAudit({
    action: "transcode.enqueued",
    entityType: "video_submission",
    entityId: sub.id,
    metadata: { source: "whatsapp", msgId: msg.id, bucket: BUCKETS.videosOriginal, objectKey },
  });
}

/**
 * Read the routing prefix out of a caption.
 *
 * Returns BOTH forms of the code, because the two sides of this lookup do not
 * agree on whether the prefix is part of it:
 *
 *   caption        "OBS-2026-004"
 *   bare           "2026-004"      <- what this used to return
 *   full           "OBS-2026-004"  <- what observation_cycles.code stores
 *
 * The observation branch compared the BARE code against a column holding the
 * FULL one, so `WHERE code = '2026-004'` never matched a row. Every caption a
 * teacher was told to write -- the whole point of the prefix convention -- fell
 * through to the 'generic' branch and the video arrived attached to nothing.
 * It failed quietly, by design: the fall-through exists so a typo cannot block
 * an upload, which also meant a systematic mismatch looked exactly like a
 * programme full of typists.
 *
 * Matching on either form keeps it working whichever convention a future seed
 * or import uses.
 */
function parseCaption(caption: string): {
  type: "observation_cycle" | "teach_back" | "mentor_meeting" | "generic";
  code?: string;
  fullCode?: string;
} {
  // OBS-<code>  -> observation_cycle
  // TB-<code>   -> teach_back
  // MM-<code>   -> mentor_meeting
  // anything else -> generic
  const m = caption.match(/^(OBS|TB|MM)-([A-Za-z0-9._-]+)/);
  if (!m) return { type: "generic" };
  const tag = m[1]!.toUpperCase();
  const bare = m[2]!;
  const full = `${tag}-${bare}`;
  if (tag === "OBS") return { type: "observation_cycle", code: bare, fullCode: full };
  if (tag === "TB") return { type: "teach_back", code: bare, fullCode: full };
  if (tag === "MM") return { type: "mentor_meeting", code: bare, fullCode: full };
  return { type: "generic" };
}


async function fetchMediaUrl(mediaId: string): Promise<string | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { url?: string };
    return j.url ?? null;
  } catch {
    return null;
  }
}

/**
 * WhatsApp Cloud API caps video at 16 MB, so this is buffered rather than
 * streamed. The cap below is generous headroom over that, and it is enforced
 * rather than assumed: this function fetches a URL supplied by an upstream
 * service into memory, and "the platform promises it is small" is not a memory
 * bound. A response that declares or delivers more is refused.
 */
const MAX_WHATSAPP_MEDIA_BYTES = 64 * 1024 * 1024;

async function downloadMediaBytes(url: string): Promise<Uint8Array | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;

    const declared = Number(r.headers.get("content-length") ?? "0");
    if (declared > MAX_WHATSAPP_MEDIA_BYTES) {
      console.error(`[whatsapp] media declares ${declared} bytes, over the cap — refusing`);
      return null;
    }

    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_WHATSAPP_MEDIA_BYTES) {
      console.error(`[whatsapp] media delivered ${buf.byteLength} bytes, over the cap — discarding`);
      return null;
    }
    return new Uint8Array(buf);
  } catch {
    return null;
  }
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


function verifySignature(raw: string, signatureHeader: string): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    console.error(
      "[whatsapp] WHATSAPP_APP_SECRET is not set — REFUSING the webhook. " +
        "Set it to the app secret from Meta's dashboard; ingest is disabled until you do.",
    );
    return false;
  }
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  if (signatureHeader.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}
