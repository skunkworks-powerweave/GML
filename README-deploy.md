# GML LMS — deployment and operations

For the IT team taking this over. Written to be followed by someone who has not
seen the codebase.

---


## 1. What you are deploying

Three long-running containers on **one** EC2 instance, plus a one-shot schema
job:

| Container | What it does |
|---|---|
| `caddy` | TLS termination and reverse proxy. The only thing with published ports (80/443). |
| `app` | Next.js — HTML, API, server actions. |
| `worker` | ffmpeg transcoding, job queue consumer, periodic sweeps. |
| `migrate` | Runs once per deploy, applies schema changes, exits. `app` and `worker` do not start until it exits 0. |

Everything stateful lives in **Supabase** (Postgres, Auth, Storage). The box
holds no database and no object store.

**Video bytes never pass through this host, in either direction.** Uploads go
browser → Supabase Storage directly. Playback segments are fetched by the
browser from Supabase's CDN using signed URLs embedded in the playlist the app
generates. EC2 serves HTML, RSC and API only. That is the single biggest factor
in how small the instance can be, and it is why the numbers in §3 look low for
a video product.

---

## 2. Prerequisites

### 2.1 Supabase project

**Pro plan is required, not preferred.** On Free: uploads cap at 50 MB per file
(videos run to 2 GB), there are no backups, and **projects auto-pause after a
week idle** — a paused project is an outage.

Region: **ap-south-1 (Mumbai)**. Measured from this project: ~11 ms median query
round-trip. Seoul was 139 ms.

Note: **point-in-time recovery is NOT included in Pro.** It is a separate paid
add-on. Without it, Supabase's own recovery granularity is "yesterday", which is
why §7 exists.

### 2.2 Two manual dashboard steps

Neither has a SQL equivalent, and the application does not work without the
first one.

**a) Enable the access-token hook.** Authentication → Hooks → *Customize Access
Token (JWT) Claims* → Postgres → schema `public`, function
`custom_access_token_hook` → Enable.

Until this is on, no token carries the `user_role` claim, `auth()` returns null
for everyone, and **nobody can sign in** — including the administrator the seed
creates. That is deliberate fail-closed behaviour, not a bug, but it is the
single most commonly missed step. `scripts/verify-auth.mjs` tells you plainly if
it is off.

**b) Set the access-token lifetime.** Authentication → Sessions → *Access token
(JWT) expiry*. The default is 3600 s. **Set it to 900 s.**

This is the window a deactivated user keeps working. Deactivation kills their
refresh tokens and bans the account immediately, but the access token already in
their browser cannot be revoked — it simply expires. One hour of residual access
for someone you have just removed is a long time; 15 minutes is not.

### 2.3 Optional: outbound email

SMTP is configured **in Supabase** (Authentication → Emails → SMTP Settings),
not in this application. Until you attach a provider, leave
`AUTH_EMAIL_ENABLED=false`.

While false, magic-link sign-in and self-service password reset are hidden, and
the UI says plainly that password resets go through an administrator. That is
true, and better than accepting an address and promising a message that cannot
be sent. Administrators create accounts with a password at `/admin/users` and
hand it over directly.

When you attach SMTP: set `AUTH_EMAIL_ENABLED=true` and redeploy. No code change.

### 2.4 AWS

| Item | Value |
|---|---|
| Instance | `m7i-flex.large` (2 vCPU, 8 GiB) — or `t3.large` in **unlimited** credit mode |
| Root volume | 30 GiB gp3 |
| Data volume | 100 GiB gp3 mounted at `/var/lib/gml` (ffmpeg scratch + local dumps) |
| Region | `ap-south-1` |
| Security group in | 80, 443 from `0.0.0.0/0`; 22 from your admin range **only** |
| Security group out | 443 (Supabase, Let's Encrypt, Meta) **and 80** — `docker/worker.Dockerfile` installs ffmpeg with apt, and `node:22-slim`'s Debian sources are `http://deb.debian.org` on port 80. With 443 only, the worker image fails to build on the first deploy. |
| DNS | An A record for `DOMAIN` pointing at the Elastic IP, **before** first deploy — Caddy needs it to obtain a certificate |

**Why not a plain burstable instance.** Sizing is driven by ffmpeg, not by
viewers. A `t3.large` in standard mode exhausts its CPU credits during a
transcode burst and throttles the web tier along with it. Unlimited mode or
`m7i-flex` avoids that.

**`WORKER_CONCURRENCY` must be 1.** One ffmpeg at `-preset veryfast` saturates
both vCPUs; a second starves Next.js on the same box. Queue depth absorbs
bursts — that is what a queue is for.

---

## 3. First deploy

```bash
# On the instance, as a user in the docker group
sudo mkdir -p /var/lib/gml && sudo chown "$USER" /var/lib/gml
git clone <repo> gml-lms && cd gml-lms   # the repo root IS the app root

cp .env.example .env
chmod 600 .env
# Fill in .env — every REQUIRED variable is marked. The stack refuses to start
# without them rather than defaulting to something that looks like it works.

./scripts/deploy.sh
```

`deploy.sh` runs: preflight → tag current images as `:previous` → build → `up`
(migrate gates app/worker) → wait for health through Caddy → seed → verify auth.

It is idempotent. Re-running it is the normal upgrade path.

**Write down the section-gate passwords the seed prints.** They are shown once;
only the hash is stored. You can rotate them later at `/admin/gates`.

---

### 3.1 Clearing the demonstration data

The seed inserts two kinds of row and does not distinguish them. The
**districts and zones are real** Ladakh administrative divisions, and so are
the phases, terms, subjects, form and quiz catalogues, and section gates —
keep all of it. (One exception: the three observation-form templates are
stored on the demo cycle `OBS-2026-001`, so they go when it goes. Nothing in
the application reads them, and on every later deploy the seed step prints a
warning that `OBS-2026-001` is gone and carries on — that warning is expected.)

The **schools, teachers, mentors, pairings and observation cycles are
invented**: ten schools with sequential contact numbers, ten teachers with
sequential mobiles (`+91 9419100001..`), two mentors (Dr. Anjali Bhatt and
Prof. Iqbal Hussain), and eight cycles `OBS-2026-001..008`.
Left in place they appear in the roster, in QuickFind, in every admin grid and
in the dashboard counts, indistinguishable from real staff.

```bash
docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/purge_demo_data.ts
```

That is a **dry run** — it prints what would go and changes nothing. Add
`--apply` to commit, which runs in a single transaction.

Two things it does deliberately:

- **It keeps the districts.** `seed.ts` skips everything when any district
  exists, and `deploy.sh` runs the seed on every deploy — so removing them
  would reinstate all of this on the next deployment.
- **It keeps anything with real work attached.** A demo cycle that has acquired
  a genuine form, video or evidence row, or a demo teacher who has been given a
  login, is reported and left alone rather than cascaded away. A kept cycle's
  teacher (and that teacher's school) is kept with it, because a cycle cannot
  exist without its teacher.

Safe to run twice; the second run finds nothing.

### 3.2 Loading your programme's data (the Repository reads zero until you do)

**Empty screens after a first deploy are expected, not a fault.** The seed
never writes `classes`, `course_outlines`, `outline_lessons`, `sessions`,
`learners`, `resources`, `resource_subjects`, `rtt_modules`, `rtt_lessons`,
`rtt_readings` or `rtt_sessions`, and the purge in 3.1 additionally empties
`schools`, `teachers`,
`mentors`, `mentor_pairings` and `observation_cycles`. So the Repository home
shows Classes 0, Course outlines 0, Sessions 0, Learners 0 and Reading material
0 with an empty week table, every RTT subject page says "No modules yet", and
`/observation` lists nothing, until you load your own rows.

**Where.** Sign in as an administrator and open **`/admin`** ("All tables" under
Data in the sidebar; the Data tab on a phone). It lists every editable table;
each opens a grid at
`/admin/data/<table>` with **Add row**, per-row edit and delete, **Import CSV**
and **Export CSV**. Every change is written to the audit log.

**CSV import.** The first line is a header of field names, exactly as the
grid's add-row form labels them (`name`, `code`, `zoneId`, ...). Each row is
checked with the same rules as the form; rows that fail are reported by line
number with the reason, and the valid rows are inserted together. Leave a cell
empty for "not set". `true`/`false` are booleans.

**Parents are referenced by id, not by name or code.** `classes.csv` needs a
`schoolId`, `learners.csv` a `classId`, and so on, and those are UUIDs — the
import does not look a school up by its code. So load in order, and for each
parent:

1. import (or add) the parent rows;
2. press **Export CSV** on the parent's grid — the first column is `id`;
3. paste those ids into the child sheet's `schoolId` / `classId` / ... column;
4. import the child.

A workable order: **schools** (`zoneId` from the zones export; the seed's zones
are real) → **teachers** (`schoolId`) and **mentors** → **mentor-pairings**
(`mentorId`, `teacherId`) → **classes** (`schoolId`) → **learners** and
**sessions** (`classId`, `schoolId`; sessions also `subjectId`, `teacherId`) →
**course-outlines** (`subjectId`) → **outline-lessons** (`outlineId`) →
**resources** → **resource-subjects**. For training content: **rtt-modules**
(`rttSubjectId`, from the seeded rtt-subjects) → **rtt-lessons**
(`rttModuleId`), and **rtt-readings** (`rttSubjectId`, plus an `http(s)://`
`externalUrl`).

**Observation cycles** are easiest from **`/observation/new`**, which offers
teacher and observer pickers and assigns the `OBS-<year>-<NNN>` code. The grid
at `/admin/data/observation-cycles` takes CSV too, but its `observerId` is the
observer's login (user) id, which no screen shows; use the form unless you are
loading many at once.

## 4. Upgrading

```bash
cd gml-lms && git pull && cd lms-app && ./scripts/deploy.sh
```

If a migration fails, `migrate` exits non-zero, `app` and `worker` never start,
and **the previous containers keep serving**. That is the intended posture:
a bad schema change degrades to "no deploy happened" rather than "the site is
down".

### Rolling back

```bash
./scripts/rollback.sh
```

Restarts `app` and `worker` from the `:previous` image. It asks for
confirmation.

**It does not touch the database.** Migrations are forward-only and there are no
down-sections. If a *migration* is the problem, you need §7's restore procedure,
which loses everything written since the backup — a deliberate, destructive act,
not something a script should do for you.

This asymmetry is why schema changes should **add** a column in one release and
**drop** it in a later one, never both in the same deploy.

---

## 5. Verifying a deploy

```bash
# Auth wiring, end to end. Creates a throwaway account, exercises it, deletes it.
docker compose run --rm --no-deps migrate node scripts/verify-auth.mjs

# Health. 503 until db, storage AND migrations all pass.
curl -s https://$DOMAIN/api/health | jq
```

Healthy output:

```json
{ "ok": true, "app": true, "db": true, "storage": true, "migrations": true,
  "migrationsApplied": 25, "migrationsExpected": 25 }
```

`/api/health` returns **503** when anything is false. It used to return 200 with
`ok:false`, which meant the Docker healthcheck and the deploy script both called
a stack with no schema "healthy".

---

## 6. Day-to-day operations

### Creating accounts

`/admin/users`. Set an initial password and hand it over; the account holder
changes it in Settings. There is no invite email unless you have configured SMTP
(§2.3).

Deactivating an account does three things: sets the profile inactive (the hook
then refuses to mint tokens), ends the user's sessions on every device, and bans
the auth user so the correct password no longer works. Residual access is the
access token already in their browser — hence §2.2b.

### Logs

```bash
docker compose logs -f app
docker compose logs -f worker
docker compose ps           # health of each container
```

### The transcode queue

`/admin/transcode-jobs` shows queue depth and failed jobs, with Retry and Drop.

A job that has exhausted its attempts is **dead**, not merely failed — the
distinction is what tells you "will be retried automatically" from "needs a
human". A worker killed mid-job has its work requeued by the lease reaper within
about a minute.

### Log rotation

Docker's default `json-file` driver grows without bound. Set this up once:

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
JSON
sudo systemctl restart docker
```

### Unattended security updates

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 7. Backup and recovery

### What Supabase covers, and what it does not

| | Covered by Supabase Pro | Covered by us |
|---|---|---|
| Postgres | Daily, 7-day retention | `scripts/backup.sh` → S3 bucket you control |
| Point-in-time | **No** — separate paid add-on | Daily granularity only |
| **Storage (the videos)** | **NOTHING. There is no backup product for Supabase Storage.** | `scripts/backup.sh` → `rclone` mirror |

That middle-right cell is the important one. The videos are a year of classroom
recordings that cannot be re-made. If we do not mirror them, nobody does.

### Setting it up

```bash
sudo apt-get install -y postgresql-client-16 rclone awscli

# Supabase Storage S3 credentials: Project Settings -> Storage -> S3 access keys
# Add to .env: SUPABASE_S3_ENDPOINT, SUPABASE_S3_ACCESS_KEY,
#              SUPABASE_S3_SECRET_KEY, BACKUP_S3_BUCKET, AWS_REGION

crontab -e
# 0 2 * * *  cd /home/ubuntu/gml-lms && ./scripts/backup.sh >> /var/lib/gml/backup.log 2>&1
# 0 4 * * 0  cd /home/ubuntu/gml-lms && ./scripts/restore.sh >> /var/lib/gml/drill.log 2>&1
```

If the Storage credentials are absent, `backup.sh` **warns loudly on stderr and
continues** rather than failing. Check the log after the first run: a backup that
silently omits the irreplaceable half is worse than one that fails.

### The weekly drill

`scripts/restore.sh` restores the newest dump into a throwaway local database,
asserts the schema and row counts look sane, drops it, and stamps
`workspace/last_restore_drill.json`. `deploy.sh` refuses to deploy in production
if that stamp is missing or older than 30 days.

The stamp reports `"storage_verified": false`, honestly — the drill exercises the
database only. To check the object mirror, pick a known key and confirm it exists
under `$BACKUP_S3_BUCKET/storage/`.

### Restoring for real

1. Stop the app: `docker compose stop app worker`
2. Restore the dump into a fresh Supabase project (or a new database on the
   existing one) with `pg_restore --no-owner --no-acl`.
3. Restore objects: `rclone copy` the S3 mirror back into the Storage buckets.
   Use `copy`, not `sync` — `sync` would delete anything in the destination
   that is absent from the mirror, which during a partial recovery means
   deleting the objects you still had. (`backup.sh` uses `copy` for the same
   reason in the other direction: a deletion inside Supabase must never
   propagate into the DR bucket.)
4. Re-run the two dashboard steps in §2.2 — **hooks and settings are not in the
   dump.**
5. Point `DATABASE_URL` and the Supabase keys at the restored project, redeploy.

Step 4 is the one people miss. A perfectly restored database with no
access-token hook is a site nobody can log into.

---

## 8. Secrets

`.env` at mode `600` is the baseline. **AWS SSM Parameter Store** (SecureString,
pulled at boot by the deploy script) is the recommended upgrade — it keeps
secrets off the instance disk and gives you rotation and an audit trail without
adding a service.

`SUPABASE_SECRET_KEY` is the one that matters most: it bypasses RLS entirely and
can create, ban and delete accounts. It must never reach a browser.

`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is safe in the browser bundle by design.
On its own it grants nothing — every table has RLS with no policies and the
`anon` role has been stripped of all privileges.

---

## 9. Cost

| Item | Monthly (ap-south-1) |
|---|---|
| EC2 `m7i-flex.large` + 130 GiB gp3 | ~$75 |
| Elastic IP, snapshots, CloudWatch | ~$8 |
| Supabase Pro | $25 |
| S3 for DR (100 GB + requests) | ~$3 |
| **Baseline** | **~$111** |

**Supabase egress is a real budget line, not a footnote.** At ~864 kbps, one
viewer-hour is ~0.39 GB. Pro includes 250 GB/month (~640 viewer-hours). Fifty
mentors watching 2 h/week ≈ 430 GB/month → ~180 GB overage ≈ **$16/month**,
scaling linearly at $0.09/GB.

Worth modelling against real expected usage before go-live. Note this also
confirms the architecture: routing segments through EC2 instead would be *more*
expensive, since AWS ap-south-1 egress is ~$0.109/GB, and it would need a bigger
instance to carry the traffic.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nobody can sign in; correct passwords rejected | Access-token hook not enabled | §2.2a. Confirm with `verify-auth.mjs`. |
| `/api/health` 503, `migrations: false` | `migrate` failed | `docker compose logs migrate` |
| `/api/health` 503, `storage: false` | Supabase keys wrong, or buckets missing | Re-run `migrate`; it creates the buckets. |
| Caddy will not get a certificate | DNS not pointing here yet, or 80 blocked | Check the A record and the security group. |
| Videos upload but never play | Worker not running, or ffmpeg missing | `docker compose ps worker`; `/admin/transcode-jobs` |
| WhatsApp videos not arriving | `WHATSAPP_APP_SECRET` wrong | The webhook **refuses all traffic** without a correct secret — by design. Check `docker compose logs app` for the refusal line. |
| A page is blank with a console CSP error | CSP too strict after a Next upgrade | `docker/Caddyfile`. A violation is silent server-side. |
| Worker container unhealthy | Cannot reach the database | Check `DATABASE_URL` uses the **session** pooler (port 5432), not transaction (6543) |

### One thing that will look like a bug and is not

`DATABASE_URL` must use Supabase's **session pooler on port 5432**, never the
transaction pooler on 6543. Transaction mode disables prepared statements, which
Drizzle relies on. The symptom is intermittent, confusing query failures under
load rather than a clean error at startup.
