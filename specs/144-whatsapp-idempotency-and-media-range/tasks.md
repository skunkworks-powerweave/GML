# Tasks 144

- [x] T1 → author `tests/governance/test_144_whatsapp_idempotency_and_media_range.test.mjs`
  with ≥10 assertions covering: schema declares `whatsapp_message_id`
  column on `videoSubmissions`; schema declares a partial unique
  index with the `WHERE … IS NOT NULL` predicate; the migration SQL
  contains both `ALTER TABLE … ADD COLUMN` and `CREATE UNIQUE INDEX
  … WHERE`; the drizzle journal references `0017_whatsapp_dedup`;
  the webhook route pre-checks `whatsappMessageId = msg.id`; the
  webhook audits `whatsapp.message.replay_ignored`; the webhook
  insert carries `whatsappMessageId: msg.id` and uses
  `onConflictDoNothing`; the media route reads the incoming `Range`
  header; it passes `Range` into `GetObjectCommand`; the media route
  returns 206 with `Content-Range` on the range branch; the no-range
  branch advertises `Accept-Ranges: bytes`; the five spec-kit files
  exist; the plan follows CREATED/EDITED/MIGRATED contract. Run the
  suite → red.
- [x] T2 → edit `packages/db/src/schema/videos.ts`: add
  `whatsappMessageId: text("whatsapp_message_id")` to
  `videoSubmissions`; add `uniqueIndex("video_submissions_whatsapp_message_id_uq")
  .on(t.whatsappMessageId).where(sql\`${t.whatsappMessageId} IS NOT
  NULL\`)`.
- [x] T3 → create `packages/db/src/migrations/0017_whatsapp_dedup.sql`
  with the two-statement ALTER + CREATE UNIQUE INDEX migration.
- [x] T4 → append a journal entry `{ idx: 17, tag:
  "0017_whatsapp_dedup", … }` to
  `packages/db/src/migrations/meta/_journal.json`.
- [x] T5 → create `packages/db/src/migrations/meta/0017_snapshot.json`
  by copying the prior snapshot and adding the new column + partial
  unique index to `public.video_submissions`.
- [x] T6 → edit `apps/web/src/app/api/webhooks/whatsapp/route.ts`:
  add the SELECT pre-check + replay audit + the insert-time
  `whatsappMessageId` + `.onConflictDoNothing({ target, where:
  isNotNull(...) })`. Add a second `replay_ignored` audit on the
  conflict-loss path so the race is observable.
- [x] T7 → edit `apps/web/src/app/api/media/[token]/route.ts`: import
  `GetObjectCommand` + `getMinio`, branch on `req.headers.get("range")`,
  pass the verbatim Range to `GetObjectCommand`, return 206 with
  `Content-Range` + `Content-Length` + `Accept-Ranges` headers; the
  no-range path stays 200 + full body but adds `Accept-Ranges`.
- [x] T8 → author all five spec-kit files under
  `specs/144-whatsapp-idempotency-and-media-range/`.
- [x] T9 → run the scoped governance suite
  (`pnpm test -- --test-name-pattern "spec 144"`). All green.
- [ ] T10 (future) → retroactive dedup sweep over rows inserted
  before 0017 was applied. Out of scope — no production data exists
  yet, and the migration leaves NULL rows intact.
- [ ] T11 (future) → Range support on the worker's HLS-master
  download path. Out of scope here; the worker downloads the full
  original sequentially during transcode and Range there would just
  add complexity without saving bandwidth (the original is fetched
  once from MinIO over the docker network).
- [ ] T12 (future) → instrument a Sentry transaction span around the
  pre-check SELECT so we can watch the replay rate in production.
  Out of scope; the audit log captures it already.
