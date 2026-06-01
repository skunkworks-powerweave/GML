#!/usr/bin/env bash
# Spec 091 — nightly backup script. Run from cron on the host.
# Spec 109 — strict mirror: MinIO mirror failures abort the backup
#            (no silent || true swallowing) so recovery never loses
#            video assets to a quietly-skipped object-storage step.
# Backs up: Postgres dump + MinIO mirror to a local /backups/ directory.
# Retention: 14 daily + 4 weekly (Sundays).

set -euo pipefail
trap 'echo "[backup] FAILED at line $LINENO" >&2' ERR

BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
DATE_STAMP="$(date +%Y%m%d-%H%M)"
DOW="$(date +%u)"  # 1-7, 7=Sunday
DB_NAME="${POSTGRES_DB:-gml_lms}"
DB_USER="${POSTGRES_USER:-gml}"

DB_DIR="$BACKUP_ROOT/db"
OBJ_DIR="$BACKUP_ROOT/objects"
mkdir -p "$DB_DIR" "$OBJ_DIR"

echo "[backup] $(date -Iseconds) — Postgres → $DB_DIR/${DATE_STAMP}.dump.gz"
docker compose exec -T postgres pg_dump -Fc -U "$DB_USER" "$DB_NAME" | gzip > "$DB_DIR/${DATE_STAMP}.dump.gz"

echo "[backup] $(date -Iseconds) — MinIO → $OBJ_DIR/"
docker compose exec -T minio sh -c "mc alias set local http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD >/dev/null && mc mirror --overwrite local/ /tmp/mirror >/dev/null"
docker compose cp minio:/tmp/mirror "$OBJ_DIR/${DATE_STAMP}/"
MIRROR_SIZE="$(du -sh "$OBJ_DIR/${DATE_STAMP}" 2>/dev/null | awk '{print $1}')"
echo "[backup] $(date -Iseconds) — MinIO mirror complete: ${MIRROR_SIZE:-unknown}"

# Retention: keep 14 daily; if Sunday, also keep in weekly/.
WEEKLY_DIR="$BACKUP_ROOT/weekly"
mkdir -p "$WEEKLY_DIR"
if [ "$DOW" = "7" ]; then
  cp "$DB_DIR/${DATE_STAMP}.dump.gz" "$WEEKLY_DIR/" 2>/dev/null || true
fi

# Prune
find "$DB_DIR" -name "*.dump.gz" -mtime +14 -delete 2>/dev/null || true
find "$WEEKLY_DIR" -name "*.dump.gz" -mtime +28 -delete 2>/dev/null || true
find "$OBJ_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} \; 2>/dev/null || true

echo "[backup] $(date -Iseconds) — done. Daily=$(ls "$DB_DIR" | wc -l) Weekly=$(ls "$WEEKLY_DIR" | wc -l)"

# SM-5 drill anchor — record last successful backup
date -Iseconds > "$BACKUP_ROOT/last-backup.txt"
