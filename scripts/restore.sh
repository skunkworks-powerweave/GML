#!/usr/bin/env bash
# Spec 091 — restore drill script. Run BEFORE production deploys.
# Restores the latest dump to a temporary `gml_lms_drill` database, runs a
# sanity SELECT, then drops the drill db. Updates workspace/last_restore_drill.json
# so the SM-5 deploy gate passes.

set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
DRILL_DB="${DRILL_DB:-gml_lms_drill}"
DB_USER="${POSTGRES_USER:-gml}"

LATEST_DUMP="$(ls -t "$BACKUP_ROOT/db/"*.dump.gz | head -1)"
if [ -z "$LATEST_DUMP" ]; then
  echo "[restore] no backups found in $BACKUP_ROOT/db"
  exit 1
fi

echo "[restore] using $LATEST_DUMP → $DRILL_DB"

# Drop + recreate drill db
docker compose exec -T postgres psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" -c "CREATE DATABASE $DRILL_DB;"

# Restore
gunzip -c "$LATEST_DUMP" | docker compose exec -T postgres pg_restore -U "$DB_USER" -d "$DRILL_DB" --no-owner --no-acl --clean --if-exists

# Sanity SELECT
docker compose exec -T postgres psql -U "$DB_USER" -d "$DRILL_DB" -c "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM audit_log) AS audit, (SELECT COUNT(*) FROM video_submissions) AS videos;"

# Clean up
docker compose exec -T postgres psql -U "$DB_USER" -d postgres -c "DROP DATABASE $DRILL_DB;"

# SM-5: stamp the drill
mkdir -p workspace
cat > workspace/last_restore_drill.json <<EOF
{
  "ranAt": "$(date -Iseconds)",
  "result": "ok",
  "dumpUsed": "$(basename "$LATEST_DUMP")"
}
EOF

echo "[restore] drill complete. SM-5 stamp written to workspace/last_restore_drill.json"
