-- Spec 144 — WhatsApp webhook idempotency.
--
-- Meta's WhatsApp Business Cloud API uses at-least-once delivery. If the
-- webhook response is not a 2xx within ~20 s, Meta retries the same payload
-- 2-3 more times. Without dedup, a single teacher upload creates 2-3 rows
-- in video_submissions PLUS 2-3 BullMQ transcode jobs running ffmpeg in
-- parallel — wasted CPU, duplicate HLS bundles, and a confusing UX where
-- the same video appears N times in /videos and the cycle drill-in.
--
-- Fix: store the wa message_id on video_submissions and enforce uniqueness
-- at the DB layer via a PARTIAL UNIQUE INDEX (only when NOT NULL so other
-- sources — direct tusd upload, external_url — are exempt and continue to
-- carry NULL). The webhook also pre-checks SELECT WHERE whatsapp_message_id
-- = msg.id and short-circuits to a 200 OK + audit 'whatsapp.message.replay_
-- ignored' so Meta stops retrying. The DB index is the belt; the pre-check
-- is the suspenders.
ALTER TABLE "video_submissions" ADD COLUMN "whatsapp_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "video_submissions_whatsapp_message_id_uq" ON "video_submissions" USING btree ("whatsapp_message_id") WHERE "whatsapp_message_id" IS NOT NULL;
