# Research 109

## D-001 — Hard fail on mirror failure beats silent skip

The original `|| true` was almost certainly added because an empty MinIO instance (no buckets, fresh install) makes `mc mirror local/ /tmp/mirror` exit non-zero, and the author wanted the script to survive that. The cost of that convenience is that every real failure mode (network partition, auth misconfig, container restart mid-mirror, disk full) now also looks like "empty MinIO" to the script. We pick hard-fail because the SM-5 drill's freshness signal (`last-backup.txt`) and the cron mail digest both depend on the script's exit code being honest. A genuinely-empty MinIO is rare in production (we seed at least one bucket via spec 102) and a fresh install is exactly when an operator is watching the script's output anyway, so hard-fail in that case is acceptable noise.

## D-002 — `trap … ERR` over wrapping each command

We chose a single `trap 'echo "[backup] FAILED at line $LINENO" >&2' ERR` over wrapping each step in an `if … then … fi` with custom logging. The trap is one line, fires automatically on any unhandled non-zero exit under `set -e`, and includes the failing line number which is exactly the diagnostic a sleep-deprived operator needs from a cron-mail subject line. Bash's `$LINENO` inside an ERR trap reports the line of the failing command, not the trap line itself — verified against bash 5.x manual. No new dependencies.

## D-003 — `du -sh` with `${MIRROR_SIZE:-unknown}` fallback

The success log emits the mirror size for at-a-glance health monitoring ("oh, today's mirror is 12K but last week's was 4.3G — something's wrong"). We compute it with `du -sh "$OBJ_DIR/${DATE_STAMP}" 2>/dev/null | awk '{print $1}'` and bind to `MIRROR_SIZE`. The `2>/dev/null` and the `${MIRROR_SIZE:-unknown}` parameter expansion together guarantee that a `du` race (e.g. the directory being touched by something else at the same moment) can never turn this monitoring nicety into a script-aborting failure. The success path is exactly: mirror, cp, size-compute (lenient), log, continue.
