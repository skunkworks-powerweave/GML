# shellcheck shell=bash
# Where backup.sh writes dumps and restore.sh reads them. Sourced, never
# executed.
#
# BACKUP_ROOT (from .env, else /var/lib/gml/backups) is a system directory: an
# operator who runs the scripts from root's cron can create it, but the account
# that runs deploy.sh usually cannot -- and .env.example sets BACKUP_ROOT to it
# explicitly, so most .env files name it. Now that a deploy takes a backup and
# runs the drill itself when the last drill is too old (deploy.sh, SM-5), that
# account must be able to write somewhere. So, ONLY WHEN deploy.sh asks for it
# (BACKUP_ROOT_FALLBACK=1):
#
#   BACKUP_ROOT               when it exists, or can be created, and is writable
#   <repo>/workspace/backups  otherwise, said on stderr; workspace/ is gitignored
#
# Without the flag -- cron, or an operator at the prompt -- an unwritable
# BACKUP_ROOT fails the backup loudly, as it always did: a nightly backup whose
# disk did not mount must say so, not quietly fill the root disk.
#
# backup.sh and restore.sh resolve it the same way as the same user with the
# same flag, so a deploy's drill finds the dump its backup just wrote.
#
# The fallback keeps the dumps on the same disk as the checkout: that protects
# against a bad deploy or a data mistake, not against losing the server. Only
# BACKUP_S3_BUCKET (backup.sh step 3, nightly) takes a copy off the host.

# resolve_backup_root <repo-root>
resolve_backup_root() {
  local repo="$1" want="${BACKUP_ROOT:-${BACKUP_ROOT_SYSTEM_DIR:-/var/lib/gml/backups}}"
  BACKUP_ROOT="${want}"
  [ "${BACKUP_ROOT_FALLBACK:-0}" = "1" ] || return 0
  if mkdir -p "${want}" 2>/dev/null && [ -w "${want}" ]; then
    return 0
  fi
  BACKUP_ROOT="${repo}/workspace/backups"
  echo "[backups] ${want} is not writable by $(id -un 2>/dev/null || echo this user); this deploy keeps its backup in ${BACKUP_ROOT} (inside the checkout). Set BACKUP_ROOT to a directory this account can write to choose another place." >&2
}
