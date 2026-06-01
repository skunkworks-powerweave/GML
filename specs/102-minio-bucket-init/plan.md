# Plan 102

CREATED: `specs/102-minio-bucket-init/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_102_minio_bucket_init.test.mjs`
EDITED: `docker-compose.yml` (added one-shot `minio-init` service between `minio` and `tusd`; no other service blocks touched)
MIGRATED: none (no schema, no data; the four bucket names already exist as the `BUCKETS` constant in `apps/web/src/lib/video/minio.ts` from spec 039)
