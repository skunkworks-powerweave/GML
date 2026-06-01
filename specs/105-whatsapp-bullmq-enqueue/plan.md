# Plan 105

CREATED: `specs/105-whatsapp-bullmq-enqueue/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_105_whatsapp_bullmq_enqueue.test.mjs`
EDITED: `apps/web/src/app/api/webhooks/whatsapp/route.ts` (import `transcodeQueue` from `@gml/worker`; call `.add("transcode", {...source:"whatsapp"})` after `video_submissions` insert; audit `transcode.enqueued`; drop deferred-stub comment), `apps/web/package.json` (add `"@gml/worker": "workspace:*"`), `apps/worker/package.json` (add `exports` block pointing `.` → `./src/index.ts`)
MIGRATED: none
