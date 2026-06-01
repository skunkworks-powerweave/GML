# Research 102

- `apps/web/src/lib/video/minio.ts` exports `BUCKETS = { videosOriginal: "gml-videos-original", videosHls: "gml-videos-hls", posters: "gml-posters", pdfs: "gml-pdfs" }` (spec 039) — those four names are the source-of-truth the init service must mirror exactly.
- `minio/mc:latest` ships `mc mb --ignore-existing` (added in mc release 2021-04-22) so re-running the init across `docker compose up` cycles is safe and exits 0 the second time around.
- `depends_on.<svc>.condition: service_healthy` is compose-v2-only (compose-v1 ignored it); we already use this exact pattern on `tusd`, `app`, `worker`, `caddy`, so the format is proven on this stack.
