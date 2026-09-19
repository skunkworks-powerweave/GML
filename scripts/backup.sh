#!/usr/bin/env bash
# Disaster recovery: an INDEPENDENT copy of everything Supabase holds.
#
# ── WHY THIS EXISTS WHEN SUPABASE ALREADY BACKS UP ───────────────────────────
#
# Supabase Pro takes daily Postgres backups with 7-day retention. Two gaps:
#
#   1. SUPABASE STORAGE HAS NO BACKUP PRODUCT AT ALL. The videos — the thing
#      this programme spends a year producing, of classrooms that cannot be
#      re-recorded — are not backed up by anyone unless we do it. That is the
#      single most important line in this file.
#   2. Point-in-time recovery is a separate paid add-on, NOT included in Pro.
#      So the recovery granularity from Supabase alone is "yesterday".
#
# Both copies land in an S3 bucket WE control, so a mistake inside the Supabase
# account — a wrong-project delete, a billing lapse, a compromised key — does
# not take the backups with it.
#
# ── WHAT THE PREVIOUS VERSION GOT WRONG ──────────────────────────────────────
#
# It ran `mc mirror` INSIDE the `minio` server container. The `minio/minio`
# image ships the server, not the `mc` client — that is a separate image. So it
# exited 127 and, under `set -e`, killed the backup AFTER the database dump
# succeeded but BEFORE any object was captured. Its own header promised "strict
# mirror, never lose video assets"; the script did precisely the opposite of
# that under every run.

set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/gml/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_DIR="${BACKUP_ROOT}/db"
KEEP_DAILY="${KEEP_DAILY:-14}"   # mirrors /admin/system-settings -> Backup retention

log() { echo "[backup] $(date -Iseconds) — $*"; }
fail() { echo "[backup] ERROR: $*" >&2; exit 1; }

# An ERR trap so a failure is loud in cron mail rather than a silent non-zero.
trap 'echo "[backup] FAILED at line ${LINENO}" >&2' ERR

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL not set"
command -v pg_dump >/dev/null || fail "pg_dump not installed (apt-get install postgresql-client-16)"

mkdir -p "${DB_DIR}"

# ── 1. Postgres ──────────────────────────────────────────────────────────────
# Custom format (-Fc) so pg_restore can do selective restores and parallel
# loads. --no-owner because the restore target's role names differ from
# Supabase's, and ownership failures would abort an otherwise good restore.
DUMP="${DB_DIR}/gml-${STAMP}.dump"
log "dumping database"
pg_dump --format=custom --no-owner --no-acl --file="${DUMP}" "${DATABASE_URL}"
gzip -f "${DUMP}"
DUMP="${DUMP}.gz"

# A dump that is suspiciously small is a failed dump that exited 0. Checked
# here rather than discovered during a restore.
size="$(stat -c '%s' "${DUMP}")"
[ "${size}" -gt 10240 ] || fail "dump is only ${size} bytes — refusing to treat that as a backup"
log "dumped $(numfmt --to=iec "${size}" 2>/dev/null || echo "${size}B")"

# ── 2. Storage objects ───────────────────────────────────────────────────────
# Mirrored REMOTE-TO-REMOTE where possible: a 100 GB video set must never have
# to fit on the EC2 root disk on its way to S3.
#
# Supabase Storage speaks S3, but through its own endpoint with its own
# credentials (Project Settings -> Storage -> S3 access keys). Without those
# configured this step is SKIPPED LOUDLY rather than silently — a backup that
# quietly omits the irreplaceable half is worse than one that fails.
if [ -n "${SUPABASE_S3_ENDPOINT:-}" ] && [ -n "${SUPABASE_S3_ACCESS_KEY:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  command -v rclone >/dev/null || fail "rclone not installed but SUPABASE_S3_* is configured"

  # `copy`, NOT `sync`.
  #
  # THIS IS THE MOST IMPORTANT LINE IN THE FILE. `rclone sync` makes the
  # destination match the source, which means it DELETES destination objects
  # absent from the source. A deletion inside Supabase -- an accident, a bad
  # admin action, a compromised key, a ransomware wipe -- would therefore
  # propagate to the disaster-recovery bucket on the very next nightly run and
  # destroy the only copy of the videos that is not Supabase's. The backup would
  # faithfully replicate the disaster it exists to survive, within 24 hours,
  # before anyone had noticed the original.
  #
  # `copy` only adds and updates. The DR bucket grows monotonically; pruning is
  # its own lifecycle policy's job, where it is deliberate, versioned and
  # reversible -- not a side effect of a mirror job running at 3am.
  #
  # These are classroom recordings that cannot be made again.
  #
  # Credentials also move out of the command line and into the environment:
  # an argv is readable from /proc by any local account, and mirroring a 100 GB
  # video set leaves them exposed there for hours.
  export RCLONE_CONFIG_SUPASRC_TYPE=s3
  export RCLONE_CONFIG_SUPASRC_PROVIDER=Other
  export RCLONE_CONFIG_SUPASRC_ENDPOINT="${SUPABASE_S3_ENDPOINT}"
  export RCLONE_CONFIG_SUPASRC_ACCESS_KEY_ID="${SUPABASE_S3_ACCESS_KEY}"
  export RCLONE_CONFIG_SUPASRC_SECRET_ACCESS_KEY="${SUPABASE_S3_SECRET_KEY:-}"
  export RCLONE_CONFIG_DRDEST_TYPE=s3
  export RCLONE_CONFIG_DRDEST_PROVIDER=AWS
  export RCLONE_CONFIG_DRDEST_REGION="${AWS_REGION:-ap-south-1}"

  for bucket in videos-original videos-hls posters pdfs; do
    log "mirroring ${bucket}"
    rclone copy \
      "SUPASRC:${bucket}" \
      "DRDEST:${BACKUP_S3_BUCKET#s3://}/storage/${bucket}" \
      --transfers 4 --checkers 8 --stats-one-line
  done
else
  echo "[backup] WARNING: Storage mirror SKIPPED — SUPABASE_S3_ENDPOINT / SUPABASE_S3_ACCESS_KEY / BACKUP_S3_BUCKET not all set." >&2
  echo "[backup] WARNING: The videos are NOT being backed up. Supabase has no backup product for Storage." >&2
fi

# ── 3. Ship the dump off the box ─────────────────────────────────────────────
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null; then
  log "uploading dump to ${BACKUP_S3_BUCKET}"
  aws s3 cp "${DUMP}" "${BACKUP_S3_BUCKET}/db/$(basename "${DUMP}")"
else
  echo "[backup] WARNING: dump kept only on this host — a host failure loses it too." >&2
fi

# ── 4. Local retention ───────────────────────────────────────────────────────
# Deliberately NOT `|| true`. If pruning fails the disk fills, and a full disk
# is how the NEXT backup fails silently.
log "pruning local dumps older than ${KEEP_DAILY} days"
find "${DB_DIR}" -name 'gml-*.dump.gz' -mtime "+${KEEP_DAILY}" -delete

date -u +%Y-%m-%dT%H:%M:%SZ > "${BACKUP_ROOT}/last-backup.txt"
log "complete"
