# Plan 126

CREATED: `specs/126-whatsapp-ingest-log-page/{spec,plan,research,quickstart,tasks}.md`, `apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx`, `apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts`, `tests/governance/test_126_whatsapp_ingest_log_page.test.mjs`
EDITED: `apps/web/src/app/(authenticated)/videos/page.tsx` (re-target the "WhatsApp ingest log" Link from /admin/audit to /admin/whatsapp-log; gate the button behind hasAnyRole(programme_admin, super_admin))
MIGRATED: none — `video_submissions.source='whatsapp'`, `video_submissions.captionRaw`, `video_submissions.contextType`, and `audit_log.action LIKE 'whatsapp.%'` already carry every field the page reads
