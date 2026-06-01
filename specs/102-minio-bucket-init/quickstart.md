# Quickstart 102

1. `docker compose up -d minio minio-init` — `minio` boots, `minio-init` waits for the healthcheck, then runs `mc mb` four times and exits 0.
2. `docker compose run --rm minio-init mc ls local/` — confirm all four buckets exist: `gml-videos-original`, `gml-videos-hls`, `gml-posters`, `gml-pdfs`.
3. `docker compose up -d minio-init` again — second run is idempotent (`--ignore-existing` exits 0 even when buckets exist); `docker compose ps` shows `minio-init` as `Exited (0)` not in a restart loop.
