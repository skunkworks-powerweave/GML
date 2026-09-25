# Operations

Day-2 runbook. Deployment itself lives in [`../README-deploy.md`](../README-deploy.md);
this covers what you do afterwards.

---

## Daily

Nothing. The stack is meant to be left alone.

## Weekly

Check that the restore drill passed:

```bash
cat workspace/last_restore_drill.json
```

`"result": "ok"` and a `ranAt` within the last seven days. A drill that failed
says so, `"result": "failed"` with an `error`, instead of leaving no file. If it
is failed, or stale past 30 days, `scripts/deploy.sh` will refuse to deploy —
that refusal is the point, not an obstacle to work around. Fix the cause and
re-run `bash scripts/restore.sh`; `/var/lib/gml/drill.log` has the detail.

Note `"storage_verified": false` is expected and correct: the drill exercises
the database only. See [SM-5](substrate-moats.md#sm-5--backups-are-proven-restorable).

## Monthly

- Spot-check the Storage mirror: pick a known object key and confirm it exists
  under `$BACKUP_S3_BUCKET/storage/`.
- Review `/admin/audit` for anything unexpected.
- Check Supabase egress against the quota (see README-deploy.md §9). It is the
  line item most likely to surprise you.

---

## Rotating a section-gate password

`/admin/gates` → Rotate. The new password is shown **once**; only the hash is
stored.

Rotation deletes the live grants for that section, so everyone must re-enter it.
That is what rotation means, and it did not use to be true: the gate compared a
cookie to the string `"1"` and never read the grant rows, so rotating revoked
nobody and every issued cookie survived its full 8 hours.

## Deactivating a member of staff

`/admin/users` → Deactivate. Three things happen: the profile goes inactive (the
access-token hook then refuses to mint tokens), their sessions end on every
device, and the auth user is banned so the correct password no longer works.

**Residual exposure is the access token already in their browser**, which cannot
be revoked and expires on its own. That is why the token lifetime should be
900 s (README-deploy.md §2.2b). Know the bound rather than assuming it is zero.

## Someone has forgotten their password

With `AUTH_EMAIL_ENABLED=false` (the default), there is no self-service reset:
an administrator sets a new one at `/admin/users` and hands it over. Setting a
password ends that user's other sessions, which is the right behaviour when you
are not certain why they lost access.

## A video will not play

1. `/admin/transcode-jobs` — is there a failed or dead job for it?
2. **Dead** means attempts are exhausted and it needs a human. **Failed** means
   it will be retried. The distinction is deliberate.
3. Retry re-enqueues it. This works even for a submission that has been
   transcoded before — the dedupe key is scoped to live jobs precisely so a
   deliberate retry is possible.
4. If the job succeeded but playback fails, check `/api/health` for
   `storage: false`.

## The queue is backing up

```bash
docker compose logs -f worker
docker compose ps worker     # healthy?
```

The worker healthcheck asks whether it can still reach the queue. A worker that
is running but cannot claim looks identical to an idle one from the outside,
which is why the check exists — previously the container had no healthcheck at
all and a crash-loop was invisible.

A job whose worker died (killed, OOM, the box restarting) is taken back by the
lease reaper once its lease lapses -- up to 15 minutes after the worker's last
heartbeat, checked every minute. The reaper also closes that attempt's row in
`/admin/transcode-jobs` as failed ("worker stopped responding"). With attempts
left the job then runs again by itself; on its last attempt it is dead-lettered,
the video is marked failed, and that failed row carries Retry. The worker log
says which: "requeued jobs with expired leases" or "dead-lettered jobs with
expired leases".

## Disk filling up

`/var/lib/gml` holds ffmpeg scratch and local dumps. Scratch is cleaned up in a
`finally` block after every transcode; dumps are pruned after 14 days by
`scripts/backup.sh`.

If scratch is growing anyway, a worker is being killed hard enough to skip its
cleanup — check for OOM kills (`dmesg -T | grep -i oom`). The likely cause is
`WORKER_CONCURRENCY` above 1.

---

## Reading the audit log

`/admin/audit`. Action names are documented in
[`audit-actions.md`](audit-actions.md).

Two things to know:

- The log is append-only and enforced at the database
  ([SM-1](substrate-moats.md#sm-1--the-audit-log-is-append-only)). You cannot
  edit or delete a row, and neither can anyone else.
- `user_id` may name a user who no longer exists. That is intentional — it
  preserves attribution across a deletion.

---

## What is NOT monitored

Stated so nobody assumes otherwise:

- There is no alerting. Nothing pages anyone. `/api/health` returns 503 when
  something is wrong; wiring that to an uptime monitor is a five-minute job and
  has not been done.
- There are no application metrics — no request rates, no latency histograms, no
  queue-depth time series. `/admin/transcode-jobs` shows an instantaneous depth.
- Log aggregation is `docker compose logs`. Rotation is configured in
  `docker-compose.yml` (its `x-logging` anchor) at 10 MB × 3 files per service,
  about 120 MB across the stack, and needs no operator action. With no alerting
  and no metrics these logs are the only forensic record, and 30 MB of Caddy
  access lines is a few days on a busy week; raise `max-size` / `max-file` in
  that anchor if more history is wanted.

For a single-instance internal tool with fifty users this is a defensible
position. It is a position, not an oversight, and it should be revisited if the
programme grows.
