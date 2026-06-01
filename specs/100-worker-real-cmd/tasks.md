# Tasks 100

- [x] Edit `docker/worker.Dockerfile` final 3 lines: drop placeholder CMD, add `WORKDIR /app/apps/worker` + real exec-form `CMD ["pnpm","--filter","@gml/worker","exec","tsx","src/index.ts"]`.
- [x] Verify `ffmpeg` is still apt-installed in both deps and runner stages — no changes needed; assert in governance test.
- [x] Land `tests/governance/test_100_worker_real_cmd.test.mjs` with ≥ 5 assertions (no placeholder string, CMD pattern, ffmpeg present, WORKDIR pivot, JSON-exec form).
- [x] Run `pnpm test -- tests/governance/test_100_*.test.mjs` and confirm green.
