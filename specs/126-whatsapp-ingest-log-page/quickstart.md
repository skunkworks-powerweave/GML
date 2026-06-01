# Quickstart 126 — WhatsApp ingest log

Manual smoke (2 minutes):

1. Boot the stack: `pnpm dev` (web) + `pnpm --filter @gml/worker dev`
   (transcode worker) + the docker-compose db/redis/minio.
2. Sign in as a `super_admin` (the bootstrap user from spec 103). The
   videos library now shows a "WhatsApp ingest log" button in the
   header — click it.
3. The page lands at `/admin/whatsapp-log`. With a fresh DB it shows
   "No WhatsApp ingest events match the current filter." Trigger a
   webhook hit (curl the local webhook with a sample Meta payload,
   or run the seed script if the demo seed adds whatsapp rows in
   future). The page now shows a row per submission.
4. Use the Parsing filter to switch between "matched" and
   "unmatched". The unmatched view shows rows whose
   `context_type = 'generic'` — typically caption typos.
5. On a row with `status='failed'`, click "Resend transcode". The
   page reloads with the row now showing `status='queued'`, the
   transcode worker logs a new job, and `audit_log` has a fresh
   `whatsapp.transcode.resent` event.

Sign in as a `teacher` and visit `/videos`: the "WhatsApp ingest log"
button is gone. The hidden URL still 403s via /forbidden because
`requireRole(["programme_admin","super_admin"])` runs at the page
boundary too — the role gate is defence-in-depth.
