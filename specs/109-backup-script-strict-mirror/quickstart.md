# Quickstart 109

Run `BACKUP_ROOT=/tmp/gml-backup-test bash scripts/backup.sh` against a healthy stack: expect a `[backup] … — MinIO mirror complete: <size>` line and exit 0. Stop the MinIO container (`docker compose stop minio`) and re-run: expect a `[backup] FAILED at line N` line on stderr, non-zero exit, and NO `/tmp/gml-backup-test/last-backup.txt` written. Restart MinIO and re-run to confirm green-path recovery.
