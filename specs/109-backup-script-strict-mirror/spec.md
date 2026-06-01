# Spec 109 — Backup Script Strict Mirror (Workflow Run 7 Tier D3)

## Why

The deployment closure audit caught a quiet but catastrophic bug in
`scripts/backup.sh` (spec 091). The MinIO mirror line ended in `|| true`,
which means if MinIO is unreachable, the `mc` binary is missing inside
the container, the alias call fails, or the bucket list is empty in a way
that confuses `mc mirror`, the entire object-storage backup step is
silently skipped and the script continues to its "done" log line and
its retention pruning. The operator's morning cron mail says "[backup]
2026-06-01T03:14:00+05:30 — done. Daily=14 Weekly=4" and looks healthy.
But the `objects/` directory under `/backups/` is stale or empty, and
when a real recovery happens six months later — disk corruption, a
ransomware event, a "we need that classroom session from March" support
ticket — the Postgres dump restores fine but every video asset is gone.
Recovery surface for the GML LMS is exactly the things that can't be
recreated: the WhatsApp-uploaded classroom recordings, the mentor
observation videos, the offline-uploaded learner submissions. Losing
those silently is the worst failure mode this script can have, and the
`|| true` was a one-character bug that hid it.

The SM-5 disaster-recovery drill (spec 094) reads
`/backups/last-backup.txt` to know the freshness of the backup it's
about to restore from. Right now that file gets written at the bottom of
`backup.sh` regardless of whether MinIO mirroring succeeded, so the
drill happily reports a backup is fresh when in fact the object store
hasn't been mirrored in weeks. Removing `|| true` and letting `set -e`
fail the whole script if the mirror step fails means the drill timestamp
only updates on a real success — which is the contract everyone
downstream assumed was already in place.

## What

Surgical change to `scripts/backup.sh`:

1. **Remove `|| true` from the MinIO mirror invocation.** The line that
   runs `docker compose exec -T minio sh -c "… mc mirror …"` no longer
   ends in `|| true`. With `set -euo pipefail` already at the top of the
   script, this means a non-zero exit from `mc mirror` (or from the
   `mc alias set` that precedes it) now propagates and the script
   aborts before writing the "done" log and before the
   `last-backup.txt` timestamp gets updated.

2. **Remove the `|| echo "minio mirror skipped (likely empty)"` from
   the `docker compose cp` that copies the mirrored tree out of the
   MinIO container.** Same reasoning — if the copy fails, the backup
   has not produced a complete artifact and the script should fail
   loudly rather than continue.

3. **Add an explicit success log** after the cp completes:
   `[backup] <iso-timestamp> — MinIO mirror complete: <size>` where
   `<size>` comes from `du -sh "$OBJ_DIR/${DATE_STAMP}" | awk '{print
   $1}'`. The size token is `${MIRROR_SIZE:-unknown}` so a `du` race
   condition can never turn this into a script-aborting failure. The
   string `MinIO mirror complete` is the load-bearing token the SM-5
   drill greps for if/when we tighten its freshness check beyond just
   reading `last-backup.txt`.

4. **Add an `ERR` trap** at the top of the script:
   `trap 'echo "[backup] FAILED at line $LINENO" >&2' ERR`. With
   `set -e`, this fires on any unhandled non-zero exit and prints the
   failing line number to stderr, which surfaces in cron mail. Without
   the trap, `set -e` aborts silently and the only signal is the cron
   exit code — fine for monitoring tools but useless for the human
   reading the mail digest.

5. **Verify `set -euo pipefail` is on line 6.** It already is from
   spec 091, but the governance test asserts on it so a future edit
   that removes it (e.g. someone "softening" the script during a
   long debug session) is caught.

## What does NOT change

- The retention prune at the bottom of the script keeps its
  `2>/dev/null || true` because those finds operate on
  potentially-empty directories and a `find … -delete` failure on a
  missing file should not abort the script. We're explicitly tightening
  the mirror step, not removing every `|| true` indiscriminately.
- The weekly-copy step (`cp "$DB_DIR/${DATE_STAMP}.dump.gz"
  "$WEEKLY_DIR/" 2>/dev/null || true`) keeps its tolerance — it's a
  belt-and-suspenders convenience, the daily dump is the real artifact.
- The `last-backup.txt` write at the end stays where it is. Now that
  the script aborts on mirror failure, this line only executes on real
  success and the SM-5 drill's freshness signal becomes trustworthy.
- The cron schedule / crontab entry is owned by the operator who
  installs the script on the host — out of scope for this spec.
- No new dependencies. `du` is in coreutils, `awk` is POSIX,
  `trap … ERR` is bash-builtin.

## Failure semantics (new contract)

| Failure                                  | Old behavior                          | New behavior                                                |
| ---------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `mc alias set` fails                     | Silent skip, script continues         | `[backup] FAILED at line N`, exit ≠ 0, no `last-backup.txt` |
| `mc mirror` fails (network / auth)       | Silent skip, script continues         | Same — propagates via `set -e`, ERR trap logs line          |
| Bucket genuinely empty                   | `cp` failed, "skipped (likely empty)" | Hard fail (we want a real empty mirror dir, not a skip)     |
| `docker compose cp` from container fails | Silent skip, retention still pruned   | Hard fail, no retention prune, no `last-backup.txt`         |

## Definition of done

- `scripts/backup.sh` no longer contains the literal substring
  `mc mirror` followed (anywhere on the rest of that line) by `|| true`.
- `scripts/backup.sh` contains `set -euo pipefail` and a `trap … ERR`.
- `scripts/backup.sh` emits `MinIO mirror complete` on success.
- Governance test `test_109_backup_strict_mirror.test.mjs` passes
  with at least 5 assertions covering the items above.
- Existing `pnpm test` suite stays green (597/597).
