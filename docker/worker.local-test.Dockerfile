# syntax=docker/dockerfile:1.7
# TEST-ONLY worker image. NOT the image that ships.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
#
# This file is IDENTICAL to docker/worker.Dockerfile in every respect except
# where ffmpeg comes from. Production installs it with apt. On the development
# machine this was written on, apt cannot fetch ANY package:
#
#   http   E: Failed to fetch http://deb.debian.org/.../ffmpeg_5.1.9.deb
#          499  Request has been forbidden by antivirus
#   https  Certificate verification failed: the certificate issuer is unknown
#
# A corporate antivirus proxy blocks .deb downloads over HTTP and intercepts
# TLS with a CA the container does not trust. That is a property of this
# network, not of the Dockerfile or of Debian, and it will not exist on EC2 --
# but it meant the worker image could not be built here, so the transcode path
# had never been executed even once. A pipeline whose central claim is "video
# is transcoded" had never transcoded a video.
#
# Docker Hub pulls are not blocked, so this variant takes the ffmpeg and
# ffprobe binaries from mwader/static-ffmpeg, which exists to be consumed
# exactly this way.
#
# ── WHAT IT DOES AND DOES NOT VERIFY ─────────────────────────────────────────
#
# VERIFIES     the worker's own code path, end to end and for real: queue
#              claim, lease heartbeat, download from Supabase Storage, ffmpeg
#              invocation and arguments, ffprobe metadata, poster frame, HLS
#              segmentation, upload, the files / video_submissions /
#              transcode_jobs writes, and success and failure transitions.
#
# DOES NOT     verify the production image's apt layer. CI builds
#              docker/worker.Dockerfile on a GitHub runner, where no antivirus
#              proxy sits in the way, and that is what gates the real image.
#
# Do not deploy this. It is referenced only by docker-compose.local-test.yml.

ARG NODE_VERSION=22-slim

# ── base: corepack in EVERY stage that needs pnpm, including the runner ────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# ── deps: install only what @gml/worker needs ─────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json     apps/worker/package.json
COPY apps/web/package.json        apps/web/package.json
COPY packages/db/package.json     packages/db/package.json
COPY packages/ui/package.json     packages/ui/package.json
COPY packages/shared/package.json packages/shared/package.json
# `@gml/worker...` already includes @gml/worker itself; the old duplicate
# `--filter @gml/worker` was redundant.
RUN pnpm install --frozen-lockfile --filter @gml/worker...

# ── runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production

# THE ONLY DIVERGENCE FROM PRODUCTION.
#
# Production runs:
#     RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg
#
# Here the binaries are copied from a published static build instead, because
# apt cannot reach the Debian archive through this network's antivirus proxy.
# They are statically linked, so they need no shared libraries from the base
# image -- which is also why this is a safe substitution to reason about: the
# worker shells out to `ffmpeg`/`ffprobe` on PATH and cannot tell the
# difference.
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg  /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:7.1 /ffprobe /usr/local/bin/ffprobe

RUN groupadd --system --gid 1002 worker \
 && useradd  --system --uid 1002 --gid worker worker

# THE MISSING PIECE: the source. Copied FIRST, then the Linux dependency trees
# on top — same ordering as docker/app.Dockerfile, so a stray host node_modules
# can never shadow the correctly-installed ones.
COPY --chown=worker:worker package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=worker:worker apps/worker   ./apps/worker
COPY --chown=worker:worker packages/db   ./packages/db
COPY --chown=worker:worker packages/shared ./packages/shared

COPY --from=deps --chown=worker:worker /repo/node_modules                 ./node_modules
COPY --from=deps --chown=worker:worker /repo/apps/worker/node_modules     ./apps/worker/node_modules
COPY --from=deps --chown=worker:worker /repo/packages/db/node_modules     ./packages/db/node_modules

USER worker
WORKDIR /repo/apps/worker

# Invoke tsx DIRECTLY rather than shelling through `pnpm exec`.
#
# `pnpm exec ...` re-enters corepack at runtime, and corepack then tries to
# download the pinned pnpm into $HOME/.cache/node/corepack. The container runs
# as the unprivileged `worker` user, whose home is not writable, so the very
# first thing the container did was:
#
#     Error: EACCES: permission denied, mkdir '/home/worker/.cache/node/corepack/v1'
#
# i.e. even once the missing source was restored, the image still crash-looped —
# just on a different error. Found by actually running the container. Calling
# the resolved bin skips corepack entirely and removes a network dependency
# from process start.
#
# tsx is a devDependency being used at runtime, which is not ideal. Compiling to
# dist/ with esbuild would drop it from the production image and make
# `typecheck` a build-time gate; that is a deliberate follow-up, kept separate
# from fixing the image being empty.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
