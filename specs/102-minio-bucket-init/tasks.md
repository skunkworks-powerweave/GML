# Tasks 102

- [x] Edit `docker-compose.yml`: add a `minio-init` service block between `minio` and `tusd` with `image: minio/mc:latest`, `restart: "no"`, `depends_on.minio.service_healthy`, env passthrough, and a four-bucket `mc mb --ignore-existing` entrypoint.
- [x] Land `tests/governance/test_102_minio_bucket_init.test.mjs` with 4+ assertions: service declared, depends_on shape, `mc mb` + 3+ bucket names match `BUCKETS` constant, `restart: "no"` one-shot semantics.
- [x] Run `pnpm test -- tests/governance/test_102_*.test.mjs` and confirm green; spot-check `pnpm test` to make sure nothing else regresses.
