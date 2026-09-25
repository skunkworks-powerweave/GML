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
BACKUP_ERROR=""
fail() { BACKUP_ERROR="$*"; echo "[backup] ERROR: $*" >&2; exit 1; }

# An ERR trap so a failure is loud in cron mail rather than a silent non-zero.
trap '[ -n "${BACKUP_ERROR}" ] || BACKUP_ERROR="line ${LINENO}: ${BASH_COMMAND}"; echo "[backup] FAILED at line ${LINENO}" >&2' ERR

# One audit row per run: backup.complete at the end, backup.failed from here
# on any other exit -- the ERR trap does not fire for fail(), so it is caught
# on EXIT. /admin/system-settings reads backup.complete (scripts/lib/
# audit-host-job.sh says why, and why a failed write never fails the backup).
# shellcheck source=lib/audit-host-job.sh
. scripts/lib/audit-host-job.sh
BACKUP_RECORDED=""
on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ] && [ -z "${BACKUP_RECORDED}" ]; then
    [ -n "${BACKUP_ERROR}" ] || BACKUP_ERROR="exited ${rc}"
    audit_host_job backup.failed "{\"error\":\"$(audit_json_text "${BACKUP_ERROR}")\"}"
  fi
}
trap on_exit EXIT

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL not set"

# IS pg_dump NEW ENOUGH FOR THIS SERVER — not merely "is it on PATH".
#
# pg_dump aborts against a server whose major is newer than its own, and this
# check used to be `command -v pg_dump` alone, with a hint naming
# postgresql-client-16. A client-16 box against a Supabase project on 17 passed
# it and then wrote no dump, every night, with only a bare pg_dump error in
# /var/lib/gml/backup.log to show for it.
#
# The server's major is ASKED, not assumed (scripts/lib/pg-major.sh), so the
# failure below names both majors and the package that fixes it.
# shellcheck source=lib/pg-major.sh
. scripts/lib/pg-major.sh
pg_rc=0
pg_check_dump_client "${DATABASE_URL}" || pg_rc=$?
case "${pg_rc}" in
  0) log "pg_dump ${PG_CLIENT_MAJOR} can dump this PostgreSQL ${PG_SERVER_MAJOR} server" ;;
  2)
    case "${PG_CHECK_ERROR}" in
      "pg_dump is not installed"*|"psql is not installed"*)
        fail "${PG_CHECK_ERROR}. Install the PostgreSQL client from the PGDG repository (postgresql-client-<server major>) -- see README-deploy.md section 7" ;;
      *) fail "${PG_CHECK_ERROR}. Refusing to attempt a dump whose client/server compatibility is unknown." ;;
    esac
    ;;
  *) fail "${PG_CHECK_ERROR}" ;;
esac

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
# ACCEPT THE NAMES SUPABASE'S OWN DASHBOARD PRINTS.
#
# Storage -> S3 access keys shows "Access key ID" and "Secret access key", so
# that is what an operator naturally writes into .env:
#
#     SUPABASE_S3_ACCESS_KEY_ID
#     SUPABASE_S3_SECRET_ACCESS_KEY
#
# This script originally demanded SUPABASE_S3_ACCESS_KEY / _SECRET_KEY, which
# are nobody's first guess, and the mismatch is silent: the mirror is SKIPPED,
# the warning says the variables are unset, and the operator has just set them.
# Both spellings work now, dashboard names first.
S3_ACCESS_KEY="${SUPABASE_S3_ACCESS_KEY_ID:-${SUPABASE_S3_ACCESS_KEY:-}}"
S3_SECRET_KEY="${SUPABASE_S3_SECRET_ACCESS_KEY:-${SUPABASE_S3_SECRET_KEY:-}}"

# The endpoint is DERIVED when not given, because the dashboard shows a region
# far more prominently than an endpoint, and the endpoint is a fixed function
# of the project URL:
#     https://<ref>.supabase.co  ->  https://<ref>.storage.supabase.co/storage/v1/s3
#
# THE DERIVATION NEVER WORKED. The sed replacement below had been written
# through a heredoc that turned its backreference into a literal 0x01 control
# byte, so `ref` was always that one byte and the "derived" endpoint was
# https://<0x01>.storage.supabase.co/... -- rclone then failed on the first
# bucket, and `set -e` ended the run after the dump but before it was shipped
# off the box. With the backreference emitted, a URL that does not match
# passes through unchanged, which is exactly what the `!=` comparison rejects.
# tests/scripts/backup-sh.test.mjs executes this and checks the endpoint that
# rclone is actually handed; tests/scripts/scripts-hygiene.test.mjs rejects a
# control byte in any shell script.
S3_ENDPOINT="${SUPABASE_S3_ENDPOINT:-}"
STORAGE_MIRRORED=false
SHIPPED_OFFSITE=false
if [ -z "${S3_ENDPOINT}" ] && [ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ]; then
  ref="$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL}" | sed -E 's#^https?://([^.]+)\..*#\1#')"
  if [ -n "${ref}" ] && [ "${ref}" != "${NEXT_PUBLIC_SUPABASE_URL}" ]; then
    S3_ENDPOINT="https://${ref}.storage.supabase.co/storage/v1/s3"
    log "derived Storage S3 endpoint for project ${ref}"
  fi
fi

# The SECRET is part of the condition. Without it the script entered this
# branch with a key and no secret, rclone failed on the first bucket, and
# `set -e` ended the run before step 3 shipped the dump off the box -- so a
# missing secret cost the off-site dump as well as the mirror.
if [ -n "${S3_ENDPOINT}" ] && [ -n "${S3_ACCESS_KEY}" ] && [ -n "${S3_SECRET_KEY}" ] \
   && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
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
  export RCLONE_CONFIG_SUPASRC_ENDPOINT="${S3_ENDPOINT}"
  export RCLONE_CONFIG_SUPASRC_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
  export RCLONE_CONFIG_SUPASRC_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
  export RCLONE_CONFIG_DRDEST_TYPE=s3
  export RCLONE_CONFIG_DRDEST_PROVIDER=AWS
  export RCLONE_CONFIG_DRDEST_REGION="${AWS_REGION:-${SUPABASE_S3_REGION:-ap-south-1}}"
  # The DESTINATION's credentials. With no keys, rclone's s3 backend is
  # ANONYMOUS unless env_auth is on -- and this remote set neither, so every
  # write into our private DR bucket was refused and `set -e` ended the run
  # before the dump was shipped. env_auth takes the same chain the aws CLI in
  # step 3 uses: AWS_* environment variables, else the EC2 instance role
  # (README-deploy.md section 7).
  export RCLONE_CONFIG_DRDEST_ENV_AUTH=true

  for bucket in videos-original videos-hls posters pdfs; do
    log "mirroring ${bucket}"
    rclone copy \
      "SUPASRC:${bucket}" \
      "DRDEST:${BACKUP_S3_BUCKET#s3://}/storage/${bucket}" \
      --transfers 4 --checkers 8 --stats-one-line
  done
  STORAGE_MIRRORED=true
else
  echo "[backup] WARNING: Storage mirror SKIPPED. Needs an access key" >&2
  echo "[backup]          (SUPABASE_S3_ACCESS_KEY_ID), a secret" >&2
  echo "[backup]          (SUPABASE_S3_SECRET_ACCESS_KEY) and BACKUP_S3_BUCKET." >&2
  echo "[backup]          The endpoint is derived from NEXT_PUBLIC_SUPABASE_URL;" >&2
  echo "[backup]          set SUPABASE_S3_ENDPOINT to override it (e.g. a custom domain)." >&2
  echo "[backup] WARNING: The videos are NOT being backed up. Supabase has no backup product for Storage." >&2
fi

# ── 3. Ship the dump off the box ─────────────────────────────────────────────
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null; then
  log "uploading dump to ${BACKUP_S3_BUCKET}"
  aws s3 cp "${DUMP}" "${BACKUP_S3_BUCKET}/db/$(basename "${DUMP}")"
  SHIPPED_OFFSITE=true
else
  echo "[backup] WARNING: dump kept only on this host — a host failure loses it too." >&2
fi

# ── 4. Local retention ───────────────────────────────────────────────────────
# Deliberately NOT `|| true`. If pruning fails the disk fills, and a full disk
# is how the NEXT backup fails silently.
log "pruning local dumps older than ${KEEP_DAILY} days"
find "${DB_DIR}" -name 'gml-*.dump.gz' -mtime "+${KEEP_DAILY}" -delete

date -u +%Y-%m-%dT%H:%M:%SZ > "${BACKUP_ROOT}/last-backup.txt"
BACKUP_RECORDED=1
audit_host_job backup.complete \
  "{\"dump\":\"$(basename "${DUMP}")\",\"bytes\":${size},\"storage_mirrored\":${STORAGE_MIRRORED},\"shipped_offsite\":${SHIPPED_OFFSITE}}"
log "complete"
