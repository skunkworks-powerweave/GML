# Plan 109

CREATED: `specs/109-backup-script-strict-mirror/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_109_backup_strict_mirror.test.mjs`
EDITED: `scripts/backup.sh` (remove `|| true` from `mc mirror` line, remove fallback echo on `docker compose cp`, add explicit `MinIO mirror complete: <size>` success log via `du -sh`, add `trap … ERR` near top)
MIGRATED: none
