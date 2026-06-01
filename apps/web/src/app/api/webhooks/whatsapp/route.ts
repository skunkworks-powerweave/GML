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
import { files, videoSubmissions, observationCycles } from "@gml/db/schema";
import { eq } from "drizzle-orm";
import { putObject, BUCKETS } from "@/lib/video/minio";
import { recordAudit } from "@/lib/audit";

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
  await putObject(BUCKETS.videosOriginal, objectKey, bytes, msg.video.mime_type ?? "video/mp4");

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

  // Resolve context_id (look up the parent entity by caption code)
  let contextId: string | null = null;
  if (ctx.type === "observation_cycle" && ctx.code) {
    const [cycle] = await db
      .select({ id: observationCycles.id })
      .from(observationCycles)
      .where(eq(observationCycles.code, ctx.code))
      .limit(1);
    contextId = cycle?.id ?? null;
  }
  // teach_back, mentor_meeting, mentee_quarterly resolution lands as those
  // surfaces ship (specs 066, 045, 046 respectively).

  await db.insert(videoSubmissions).values({
    fileId: fileRow.id,
    source: "whatsapp",
    status: "received",
    contextType: ctx.type,
    contextId: contextId,
    captionRaw: caption,
  });

  // 6. (Spec 039+040) — enqueue the transcode job. Implementation lands when
  //    BullMQ + ffmpeg worker ship. The video stays in 'received' until then;
  //    operators see it in /admin/data/videos and can manually flip when
  //    transcoding ships.
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
