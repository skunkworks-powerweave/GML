# Quickstart 105

Send a test WhatsApp video to the GML number with caption `OBS-2026-001`. Watch worker logs: `[worker] picking job <id> { videoSubmissionId: '…', source: 'whatsapp' }` should appear within a second of the webhook returning. Verify in psql: `SELECT status FROM video_submissions WHERE caption_raw = 'OBS-2026-001' ORDER BY created_at DESC LIMIT 1;` should be `received` then `ready` after transcode completes. Audit: `SELECT action, metadata FROM audit_log WHERE action IN ('whatsapp.media.fetched','transcode.enqueued') ORDER BY created_at DESC LIMIT 4;`.
