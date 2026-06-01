# Spec 102 — MinIO bucket initialization (one-shot service)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** Workflow Run 6 (Tier A — deployment blockers)

## Overview

Closes a real deployment hole surfaced in the recent deployment audit. The `minio` service in `docker-compose.yml` brings up the MinIO server with healthy credentials, but it never creates the buckets the app actually writes to. The first time the transcode worker tries `PutObjectCommand` against `gml-videos-original` (during WhatsApp ingest, spec 036/037) or `gml-videos-hls` (during ffmpeg transcode, spec 040), the S3 SDK raises `NoSuchBucket` and the BullMQ job dies on its first attempt. The signed-URL proxy at `/api/media/[token]` (spec 042) also 404s on every read because the bucket the key references doesn't exist.

This spec adds a `minio-init` service to the compose file. It's a one-shot container (built from `minio/mc:latest`, the official MinIO admin client) that depends on `minio` being `service_healthy`, then runs `mc mb --ignore-existing` for each of the four buckets the app needs:

- `gml-videos-original` — raw incoming videos (whatsapp media downloads, direct uploads via tusd)
- `gml-videos-hls` — ffmpeg-transcoded HLS master playlists + segments (the playable artefact)
- `gml-posters` — auto-generated video thumbnails (spec 040 byproduct)
- `gml-pdfs` — resource library PDFs (spec 046/087 viewer source)

Bucket names are taken verbatim from the `BUCKETS` constant in `apps/web/src/lib/video/minio.ts`. After creating each bucket, the init script applies `mc anonymous set none` to lock the anonymous read policy off — every read in the app goes through the signed-URL proxy, no direct MinIO access is ever allowed.

The service uses `restart: "no"` because it is one-shot: it exits 0 once buckets exist and stays exited until the next `docker compose up`. Subsequent `up` cycles re-run it, but every `mc mb` call uses `--ignore-existing` so the second run is idempotent and exits 0 again.

## Functional Requirements

- **FR-001** — `docker-compose.yml` declares a `minio-init` service at the same indent level as `minio` and `tusd`.
- **FR-002** — The service uses image `minio/mc:latest` (the official MinIO client).
- **FR-003** — `restart: "no"` so the container does not loop — one-shot semantics. A successful run exits 0 and stays exited; the orchestrator does not restart it.
- **FR-004** — `depends_on.minio.condition: service_healthy` — the script can't run before `minio`'s healthcheck passes (otherwise `mc alias set` against `http://minio:9000` would race the server boot).
- **FR-005** — The entrypoint shell runs `mc alias set local http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD`, then `mc mb local/<bucket> --ignore-existing` for each of the four buckets, then `mc anonymous set none local/<bucket>` for each.
- **FR-006** — The bucket list is exactly four names matching `apps/web/src/lib/video/minio.ts` `BUCKETS`: `gml-videos-original`, `gml-videos-hls`, `gml-posters`, `gml-pdfs`. The spec asserts at least 3 of these via governance test (the fourth — `gml-pdfs` — is asserted by the same test as a fourth-name presence check).
- **FR-007** — Environment block passes `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` through to the container (same env vars `minio` itself consumes; no new secrets).
- **FR-008** — Service is attached to `lms_net` (the same compose-managed network all other services use, so the `minio:9000` DNS name resolves).
- **FR-009** — No other service is touched. The `app`, `worker`, `tusd`, `caddy`, `postgres`, `redis` blocks are unchanged. (`tusd` continues to use its own legacy `MINIO_BUCKET=gml-media` for now; closing that drift is out of scope here and tracked separately.)
- **FR-010** — `mc mb` uses `--ignore-existing` so subsequent `docker compose up` cycles do not error on already-created buckets.

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| Fresh `docker compose up -d` | `minio-init` runs once, exits 0, four buckets exist |
| `docker compose up -d` second time | `minio-init` runs again, exits 0 (idempotent via `--ignore-existing`) |
| `mc ls local/` against the running stack | Lists `gml-videos-original`, `gml-videos-hls`, `gml-posters`, `gml-pdfs` |
| Bucket policy | Anonymous reads return 403; signed-URL proxy reads work |
| `minio` not healthy yet | `minio-init` blocks on `depends_on.minio.service_healthy`; does not retry MinIO from a cold boot |
| Restart loops | Container exits 0 and stays exited — no infinite respawn |

## Out of scope

- Migrating `tusd` from its legacy `MINIO_BUCKET=gml-media` env var to write into `gml-videos-original` directly. That requires editing tusd command flags AND the upload-completion webhook that promotes the tus upload into a video row. Tracked separately as a follow-up after deployment Tier A is closed.
- Setting up MinIO event notifications (e.g. webhook on object-created) — the worker polls via BullMQ instead, by design.
- Creating IAM users / scoped access keys for the app vs worker. We use the root credentials for now; that's acceptable for a single-tenant single-host deployment and is called out as a known-acceptable tradeoff in the deployment audit.
- Versioning, lifecycle policies, replication — deferred to a later hardening pass once production usage patterns are observed.

## Design deviations

None. The `restart: "no"` + `--ignore-existing` combo is the canonical compose-native pattern for one-shot bootstrappers, and matches how Postgres init scripts work in the official Postgres image.
