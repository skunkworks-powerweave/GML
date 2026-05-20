# Architecture

Single source of truth for the architectural decisions of GML LMS.

For now, the canonical write-up lives in [`../../PLAN.md` § "Architecture"](../../PLAN.md). This doc will grow into a fuller reference as specs land.

## Service topology (target)

| Service  | Image                  | Role                                          |
|----------|------------------------|-----------------------------------------------|
| caddy    | caddy:2-alpine         | TLS termination, reverse proxy, static cache  |
| app      | custom (Node 20)       | Next.js web + API + Server Actions            |
| worker   | custom (Node 20+ffmpeg)| BullMQ jobs: transcode, HLS, WhatsApp fetch   |
| tusd     | tusproject/tusd        | Resumable upload endpoint, S3 backend → MinIO |
| postgres | postgres:16-alpine     | Primary store                                 |
| redis    | redis:7-alpine         | BullMQ + rate limit + gate cache              |
| minio    | minio/minio            | Object storage                                |

Lands as actual docker-compose in spec 002.
