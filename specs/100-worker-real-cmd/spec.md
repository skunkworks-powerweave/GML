# Spec 100 — Worker container real CMD (BullMQ consumer entrypoint)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** Workflow Run 6 — Tier A (deployment blockers)

## Overview

Closes the oldest unresolved TODO in the deployment story. When the docker-compose stack was first stood up in **spec 002** the worker image had no real entrypoint — the BullMQ consumer (`apps/worker/src/index.ts`) hadn't been written yet. To keep `docker compose up -d` reporting all 7 services as "up" during the early scaffolding phase, the worker Dockerfile shipped with a placeholder CMD:

```
CMD ["node", "-e", "console.log('worker idle — real consumer lands in spec 024'); setInterval(() => {}, 1<<30);"]
```

The real worker landed in **spec 039** (BullMQ worker setup) + **spec 040** (ffmpeg → HLS 480p transcode) and has been production-ready code on disk since. But the Dockerfile was never updated, so any deployment that `docker compose build`s the worker image still ships the idle-loop placeholder. Video submissions enqueued on a built-image deploy would sit in the `transcode` Redis queue forever — no worker would dequeue them.

This spec swaps the placeholder CMD for the real consumer entrypoint via `pnpm --filter @gml/worker exec tsx src/index.ts`. `tsx` is already in `@gml/worker`'s `devDependencies` and `pnpm install --frozen-lockfile` in the deps stage installs it. No build artifact is emitted (the worker is a long-running process, not a library) — `tsx` runs the TypeScript source directly, matching the local-dev experience.

A second concern surfaced during the audit: confirming `ffmpeg` is actually present in the runner stage. It IS — the deps and runner stages both `apt-get install -y --no-install-recommends ffmpeg ca-certificates`. The governance test asserts this so any future refactor that drops it will fail loudly.

## User stories

**US1 (DevOps — first deploy):**
As the deploy operator, when I run `docker compose build worker && docker compose up -d worker`, the worker container starts the real BullMQ consumer and begins polling the `transcode` queue. `docker compose logs worker -f` shows the bullmq Worker connected line, not "worker idle".
**Independent test:** `docker compose logs worker --tail=20 2>&1 | grep -v idle` is non-empty AND `redis-cli -h redis LLEN bull:transcode:wait` decrements when a job is enqueued.

**US2 (Video pipeline — end-to-end smoke):**
As QA verifying video upload, after uploading a 480p test clip through `/api/videos/upload` the worker dequeues the job, runs ffmpeg, uploads HLS segments to MinIO, and flips `video_submissions.status` from `queued` to `ready` within ~60 s for a 10 s clip on a modest laptop.
**Independent test:** Upload → `SELECT status FROM video_submissions WHERE id = '<id>'` — expect `ready` (not `queued` or `processing`) within 90 s; `aws s3 ls s3://lms-videos/<id>/hls/` lists ≥ 3 `.ts` segments + 1 `.m3u8`.

**US3 (Audit — image hygiene):**
As the security reviewer, I can `docker run --rm gml-lms-worker:latest ffmpeg -version` and get a real ffmpeg version string back, confirming the binary is in the image and on the worker user's PATH.
**Independent test:** Above command returns exit 0 with `ffmpeg version <semver>` in stdout.

## Functional requirements

- **FR-001** — `docker/worker.Dockerfile` no longer contains the substring `console.log('worker idle"` (the placeholder is gone, not just commented out).
- **FR-002** — The final `CMD` instruction in `docker/worker.Dockerfile` invokes `pnpm`, `node`, or `tsx` such that `apps/worker/src/index.ts` (or its compiled `dist/index.js`) is the entry module. The governance test pattern-matches this with a regex.
- **FR-003** — `ffmpeg` is installed in the runner stage (`apt-get install -y --no-install-recommends ffmpeg ...`). The governance test greps for `ffmpeg` in the Dockerfile.
- **FR-004** — `WORKDIR` is set such that `tsx`'s module resolution finds `@gml/db` and `@gml/worker`'s own `node_modules` (pnpm's per-package symlink farm). Concretely: `WORKDIR /app/apps/worker` before the `CMD`.
- **FR-005** — No new apt packages are added in this spec — the existing `ffmpeg` + `ca-certificates` + `wget` set is sufficient.
- **FR-006** — No new pnpm dependencies are added — `tsx` is already in `@gml/worker`'s devDependencies (spec 002 lockfile).
- **FR-007** — The CMD MUST be a JSON-array exec form, not a shell-form CMD. This ensures the worker is PID 1 and receives `SIGTERM` from `docker compose down` cleanly (no zombie `sh -c` wrapper).

## Acceptance criteria

| Behaviour | Verification |
| --- | --- |
| `docker compose build worker` succeeds | No new build error from the CMD swap; image size delta < 5 MB |
| `docker compose up -d worker` starts | `docker compose ps worker` shows `running` (no `HEALTHCHECK` defined, so no `healthy` requirement) |
| Worker logs show real startup | `docker compose logs worker --tail=10` mentions bullmq / queue connect, NOT "worker idle" |
| Stub string removed | `grep "worker idle" docker/worker.Dockerfile` returns no matches |
| ffmpeg present in runner | `docker run --rm gml-lms-worker:latest ffmpeg -version` exits 0 |
| Governance test green | `pnpm test -- tests/governance/test_100_worker_real_cmd.test.mjs` passes ≥ 5 assertions |

## Out of scope

- Adding a multi-stage build that emits compiled JS in a `builder` stage and runs `node dist/index.js` in the runner. Running TypeScript via `tsx` in production is the project convention (matches how the `dev` script runs locally) and avoids a second build pipeline. If startup latency becomes a problem we'll add a build stage in a follow-up Workflow Run.
- Worker `HEALTHCHECK` instruction. The worker has no HTTP endpoint; readiness is checked indirectly via Redis queue depth. Adding a healthcheck binary would inflate the image.
- Replacing `wget` with `curl` in the runner stage. `wget` is used by other Dockerfiles' healthchecks and stays for consistency.
- Pinning `tsx` to a specific patch version. Trust the lockfile (`pnpm-lock.yaml`).
- Switching to `bun` or `deno`. Out of scope for this Workflow Run; would require revisiting `@gml/db`'s `pg` native binding too.

## Design deviations

None. The CMD swap is the cleanest one-line change that unblocks deployment without restructuring the Dockerfile. The placeholder comment block is replaced inline (same number of lines) so the diff is surgical and reviewable.
