# Plan 100

EDITED: `docker/worker.Dockerfile` (last 3 lines: replaced placeholder `node -e console.log('worker idle …')` with real `pnpm --filter @gml/worker exec tsx src/index.ts` + WORKDIR pivot to `/app/apps/worker`)
CREATED: `tests/governance/test_100_worker_real_cmd.test.mjs`, `specs/100-worker-real-cmd/{spec,plan,research,quickstart,tasks}.md`
MIGRATED: none — no schema, no Compose, no install layer changes (tsx + ffmpeg are already in the deps stage)
