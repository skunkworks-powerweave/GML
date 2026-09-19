// WhatsApp Business Cloud API webhook — PRIMARY teacher upload path.
//
// Flow:
//   1. Teacher sends a video to the GML number with a caption like
//      `OBS-2026-001` (observation cycle) or `TB-eng-grade5` (teach-back).
//   2. Meta calls this webhook with the message metadata.
//   3. We verify the signature, fetch the media via Graph API, store it to
//      MinIO, create video_submissions row with source='whatsapp', then
//      enqueue a BullMQ transcode_jobs row (spec 039 + 040).
//   4. Once transcoded, the row moves to status='ready' and the teacher's
//      cycle/teach-back drill-in shows the playable HLS link.
//
// Meta deletes media 30 days after delivery, so we fetch immediately and
// retain our copy.

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@gml/db";
import { files, videoSubmissions, observationCycles, mentorMeetings } from "@gml/db/schema";
import { eq, isNotNull } from "drizzle-orm";
import { storage, BUCKETS } from "@/lib/video/storage";
import { recordAudit } from "@/lib/audit";
import { transcodeQueue } from "@gml/worker/queues";

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

  // Meta sends a batch of "entry" → "changes" → "value" → "messages".
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const messages = change.value?.messages ?? [];
      for (const msg of messages) {
        if (msg.type !== "video") continue;
        await ingestVideoMessage(msg, change.value?.metadata?.display_phone_number);
      }
    }
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
  // typo never blocks the upload — the operator sees the raw caption in
  // /admin/data/videos and can re-link manually.
  let contextType: "observation_cycle" | "teach_back" | "mentor_meeting" | "generic" = ctx.type;
  let contextId: string | null = null;

  if (ctx.type === "observation_cycle" && ctx.code) {
    const [cycle] = await db
      .select({ id: observationCycles.id })
      .from(observationCycles)
      .where(eq(observationCycles.code, ctx.code))
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

  // 6. Enqueue the BullMQ transcode job. The worker (apps/worker) picks it
  //    up, runs ffmpeg → HLS 480p, uploads segments to MinIO, then flips
  //    video_submissions.status to 'ready'.
  await transcodeQueue.add("transcode", {
    videoSubmissionId: sub.id,
    fileId: fileRow.id,
    bucket: BUCKETS.videosOriginal,
    objectKey,
    source: "whatsapp",
  });
  void recordAudit({
    action: "transcode.enqueued",
    entityType: "video_submission",
    entityId: sub.id,
    metadata: { source: "whatsapp", msgId: msg.id, bucket: BUCKETS.videosOriginal, objectKey },
  });
}

function parseCaption(caption: string): { type: "observation_cycle" | "teach_back" | "mentor_meeting" | "generic"; code?: string } {
  // OBS-<code>  → observation_cycle
  // TB-<code>   → teach_back
  // MM-<code>   → mentor_meeting
  // anything else → generic
  const m = caption.match(/^(OBS|TB|MM)-([A-Za-z0-9._-]+)/);
  if (!m) return { type: "generic" };
  const tag = m[1].toUpperCase();
  if (tag === "OBS") return { type: "observation_cycle", code: caption.match(/^OBS-([A-Za-z0-9._-]+)/)?.[1] };
  if (tag === "TB") return { type: "teach_back", code: m[2] };
  if (tag === "MM") return { type: "mentor_meeting", code: m[2] };
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

async function downloadMediaBytes(url: string): Promise<Uint8Array | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function verifySignature(raw: string, signatureHeader: string): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    // Dev mode: accept everything if no secret configured (logged via audit).
    console.warn("[whatsapp] WHATSAPP_APP_SECRET unset — accepting webhook without signature check");
    return true;
  }
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  if (signatureHeader.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}
