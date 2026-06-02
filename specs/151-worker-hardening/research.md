# Research 151

Four design choices, documented inline in the touched files and
expanded here.

## (1) Why `attempts: 3` and exponential backoff (not linear, not 5)

BullMQ accepts any positive integer for `attempts`. We picked 3
deliberately:

- **1 attempt** is the BullMQ default — too aggressive. A single
  network reset between the worker and MinIO would cost the user
  their upload.
- **5+ attempts** is too forgiving. If ffmpeg crashes on a malformed
  input file (corrupt MP4 from a WhatsApp forward, for example),
  retrying five times costs the worker ~25 minutes of wasted CPU
  before the job moves to the failed queue. Operators want signal
  about bad files, not retry storms.
- **3 attempts** with 5s/10s/20s exponential delays gives the
  network ~35 seconds to recover from a transient blip while
  surfacing genuine corruption to the failed queue inside a minute.
  This matches the LMS pattern from spec 039 (BullMQ worker setup),
  where the worker is expected to retry transient failures but
  surface persistent ones quickly.

Exponential (rather than linear / fixed) backoff because the failure
modes we're defending against — Redis hiccup, MinIO restart, transient
DNS — typically resolve within 5-30 seconds. Linear backoff would
hammer the failing service on retry 1, retry 2, retry 3 in lockstep;
exponential spaces them out so the third retry hits a likely-recovered
backend.

## (2) Why `removeOnComplete` with both `age` and `count`

BullMQ keeps completed jobs in Redis forever by default. For the
transcode queue that's roughly one hash entry per video upload — at
GML's expected ~100 uploads/day, the queue grows ~3MB/month, which
fills a small Redis cache within a year. The official BullMQ guidance
is to either set `removeOnComplete: true` (drop immediately) or pass
an object with `age` (TTL in seconds) and/or `count` (max retained).

We pass BOTH:
- `age: 24 * 3600` — keep finished jobs for a day so on-call can
  inspect "what did the worker do yesterday?" without reading
  application logs.
- `count: 100` — even if jobs land in quick succession, only keep
  the 100 newest. Bounds the maximum Redis footprint to ~3MB
  worst-case (single transcode hash entry is ~30KB after BullMQ
  serializes the input + result).

For `removeOnFail` we only pass `age: 7 * 24 * 3600` — a week is
long enough that a Monday-morning on-call can review what failed
over the weekend, and we don't want to silently drop failed jobs
just because there were a lot of them. The 7-day TTL bounds the
worst case at ~700 failed jobs in queue, which is ~21MB — still
fine for any reasonable Redis sizing.

## (3) Why clamp with `Math.max(1, Math.min(..., 16))` and not throw

Two viable shapes for defensive env parsing:

- **Throw on invalid**: `if (concurrency < 1 || concurrency > 16) throw ...`.
  The worker container fails fast on startup, the operator sees the
  error in `docker logs`, fixes the env, restarts. Loud and clear.
- **Clamp silently**: the chosen shape. The worker boots with a sane
  value, the operator notices via the startup log line (`console.log
  (worker online · concurrency=2)`) that something doesn't match
  their intent.

We chose clamp because the worker is the LMS's most critical
background process — if it fails to boot, every teacher upload after
the moment-of-failure piles up in the tus → transcode pipeline with
no consumer. Operators are unlikely to be watching the worker's
startup logs at 03:00 IST when a config push happens. Failing closed
is the LMS pattern for security-critical paths (auth, signed URLs);
for an env that controls throughput, failing open with a clamped
sane value is the better trade-off.

The startup log line `[worker] online · redis=... · concurrency=N`
already echoes the resolved value, so an operator looking for "is
my env actually applied?" will see N=16 instead of N=999 in the
logs and notice.

`|| 2` after `parseInt` is the standard JS idiom for "default if
NaN or 0". Strictly we want NaN → 2 (parse failure) and 0 → 2
(operator set to zero, almost certainly a mistake). `||` catches
both. Using `?? 2` instead would catch NaN but NOT 0, because 0
is not nullish — which would re-introduce the "concurrency=0 silently
disables the worker" failure mode the clamp is trying to fix.

`Math.min` BEFORE `Math.max` because `Math.min(parseInt | NaN, 16)`
of NaN returns NaN (Math.min propagates NaN), and we want NaN to
short-circuit to 2 via the `|| 2`. Composing the other way
(`Math.max(1, parseInt) → Math.min(..., 16)`) works too but is
slightly less robust: `Math.max(1, NaN)` returns NaN by spec, so the
clamp has to rely on the parseInt-side `|| 2` regardless. We picked
the order that reads "default → cap upper → floor lower" because
it's how a human would think about the constraints.

## (4) Why document cron timezone in a comment, not a config

Three viable shapes for the timezone fix:

- **Hardcode UTC in the cron**: BullMQ doesn't accept a timezone
  arg on `repeat: { cron, tz }` (the option exists in some forks
  but not in the version we ship with). We'd need cron-parser as
  a dep, which violates the "no new deps" rule.
- **Read TZ from an env**: `repeat: { cron, tz: process.env.WORKER_CRON_TZ }`.
  Cleaner but adds a new env var to document, deploy, and test.
  For a single cron that runs at off-hours and isn't time-sensitive,
  the operational cost isn't worth it.
- **Document the implicit dependency**: chosen. The cron fires when
  the host says so. Production hosts are UTC (we control the VPS).
  Dev compose stacks are also UTC (compose containers default to
  UTC unless `TZ` is set). The comment block names the assumption
  and gives an operator the escape hatch (`TZ=Asia/Kolkata` on the
  worker container) without us having to ship the wiring.

The comment is keyed off "Spec 151" so a future contributor doing a
file-by-file audit can find the rationale fast.

## (5) Why not also fix the retention worker's queue-name typo (no typo)

Worth noting for the record: the audit's third finding mentioned the
retention queue, but the queue name `"retention"` and the job name
`"deleteOldNotifications"` are correctly spelled and match spec 107.
No typo to fix. The fix is purely the documentation of WHEN the cron
fires, not WHAT it fires.
