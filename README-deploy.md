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

**Pro plan is required, not preferred.** On Free there are no backups, and
**projects auto-pause after a week idle** — a paused project is an outage.

**On every plan, Pro included, Storage's project-wide upload limit defaults to
50 MB**, and lesson videos run to 2 GB. It is a dashboard setting that no
migration can see or change; §2.2c raises it.

Region: **ap-south-1 (Mumbai)**. Measured from this project: ~11 ms median query
round-trip. Seoul was 139 ms.

Note: **point-in-time recovery is NOT included in Pro.** It is a separate paid
add-on. Without it, Supabase's own recovery granularity is "yesterday", which is
why §7 exists.

**Connection budget.** `DATABASE_URL` is the *session* pooler (§10), which
admits only as many clients as its **pool size** — 15 by default on the smaller
computes (Project Settings → Database → Connection pooling) — and every open
connection holds one. The sixteenth connect fails with "max clients reached":
pages error, `/api/health` answers 503, the worker cannot claim. The stack is
sized to fit 15 exactly:

| Who | Connections | Set by |
|---|---|---|
| `app` | 8 | `APP_DB_POOL_MAX` in `.env` |
| `worker` | 4 | `WORKER_DB_POOL_MAX` in `.env` |
| `migrate`, seed, verify-auth (during a deploy) | 2 | fixed in `docker-compose.yml` |
| worker healthcheck | 1 | — |

`backup.sh`'s `pg_dump` takes one more at 02:00; do not deploy then. To give
the app more, raise the pool size in the dashboard first, then
`APP_DB_POOL_MAX`.

### 2.2 Manual dashboard steps

None has a SQL equivalent. The application does not work without the first,
and does not accept a real lesson video without the third. The others close
holes that are open by default; `scripts/verify-auth.mjs` (§5) fails until the
sign-up switch (d) is off.

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
for someone you have just removed is a long time; 15 minutes is not. (For the
two administrator roles there is no such window: the application re-checks an
administrator's role and status on every request, so a demoted or deactivated
administrator loses admin access at once.)

**c) Raise the Storage upload limit.** Storage → Settings → *Upload file size
limit*. The default is 50 MB on every plan, and it binds before the 2 GB bucket
limit the migrations set: at 50 MB, anything over a minute or two of phone video
is refused at the resumable endpoint before a byte is sent, and the teacher sees
a generic upload error. **Set it to 2 GB**, the application's own ceiling
(`MAX_UPLOAD_BYTES` in `apps/web/src/lib/video/upload.ts`).
`bash scripts/preflight.sh` checks it by declaring a 600 MB upload.

**d) Turn off public sign-up.** Authentication → Sign In / Providers → turn
**off** *Allow new users to sign up*. Accounts here are created by an
administrator at `/admin/users`, which keeps working with this off.

Supabase leaves it on. While it is on, anyone holding the publishable key (every
signed-in user's browser receives it) can register any address: they can claim
a staff member's address before you create the account (your create then fails
with "already registered"), the claimed account shows in `/admin/users` as a
deactivated teacher that one press of *Reactivate* hands to them, and the
sign-up endpoint tells anyone which addresses already have accounts.
`verify-auth.mjs` reports **FAIL public sign-up is disabled** until this is off.

If an address is already squatted, remove that account and create it again at
`/admin/users`; do not reactivate it. Remove its profile first. The sign-up
wrote one (the deactivated teacher above), and the profile's link to the login
is deliberately RESTRICT, so *Delete user* in Authentication → Users fails with
"Database error deleting user" while the profile exists.

Before that, make sure it is a squatter's. A real teacher whom an
administrator deactivated also shows as a deactivated teacher. A squatter has
never signed in (Supabase issues no token to an inactive profile), so its row
in `/admin/users` says *never signed in*; check that it does. In the SQL editor:

```sql
-- 1. It should be an inactive teacher that has never signed in: last_seen_at is empty.
select id, email, role, active, last_seen_at, created_at from public.users where email = lower('<address>');
-- 2. Remove that profile. Expect DELETE 1.
delete from public.users
 where email = lower('<address>') and active = false and role = 'teacher'
   and last_seen_at is null
   and not exists (select 1 from public.teachers where teachers.user_id = users.id)
   and not exists (select 1 from public.mentors where mentors.user_id = users.id);
```

`DELETE 0` means the account has been used: it is active, has signed in, or is
linked to a teacher or mentor record. Stop, and deactivate it at `/admin/users`,
or leave it deactivated, instead. Do not loosen the statement: nothing else
refuses this delete, because every table that refers to a profile either
deletes its rows with it or unlinks them, so a used account's records would go
without an error. After `DELETE 1`, delete the user in Authentication → Users,
then create the account at `/admin/users`.

**e) Bound how long a session lives.** Authentication → Sessions → *Time-box
user sessions*: **12 hours**; *Inactivity timeout*: **2 hours** (both are Pro
features, which §2.1 requires anyway).

These are for shared school computers. The application already writes the
session cookie `Secure` on an https deployment and with a Max-Age of at most
12 hours, renewed while the person keeps using the site, so a browser left
signed in drops the session twelve hours after it was last used. Those are
browser-side limits; they do not stop a copied cookie. The two Supabase
settings are enforced by Supabase itself and do. Without them a refresh token
never expires.

**f) Make Supabase enforce the password policy.** Authentication → Sign In /
Providers → *Email*:

- *Minimum password length*: **8** (Supabase's default is 6);
- *Password requirements*: leave at the default, **no required characters**;
- *Secure password change*: **on**;
- *Require current password when changing password*: **on**.

Then Authentication → Attack Protection → *Prevent use of leaked passwords*:
**on**.

If your dashboard does not show the current-password setting, set it through
the Management API with a personal access token:
`PATCH https://api.supabase.com/v1/projects/<project-ref>/config/auth` with the
body `{"security_update_password_require_current_password": true}`.

The application checks length on every form that sets a password (at least
8 characters, at most 72 bytes), but a signed-in user can also call Supabase
directly with their own session, and there only Supabase's settings apply: 6
characters and no other checks unless you change them.

Leave *Password requirements* off because the application does not check
character classes. With them on, a password the application accepts (a long
passphrase with no digit, or one written in Devanagari or Tibetan script,
which Supabase's Latin letter and digit classes do not count) would be refused
by Supabase with a raw English message. Length and the leaked-password check are the controls
that matter.

*Require current password* is what stops a password being changed at a
browser left signed in. Page scripts can read the access token from the
session cookie by design (uploads use the token), so without it anyone at that
browser can call Supabase's user endpoint and set a new password without
knowing the current one. With it on, Supabase refuses that call from a session
opened with a password unless it carries the correct current password.
Settings sends it (it has already checked it), and `/login/reset` is
unaffected. Supabase exempts sessions opened from an emailed link (a magic
link or a password-reset link) for as long as they last, where the
application's `/login/reset` accepts one only in its first 15 minutes; that
matters only once `AUTH_EMAIL_ENABLED=true` (§2.3), and the session bounds in
(e) still limit it.

*Secure password change* is narrower than its name. Supabase asks for
reauthentication only when the session setting the password is more than
**24 hours** old. With the 12-hour time-box in (e), no session here reaches that
age, so the setting never triggers. Leave it on anyway. It costs nothing, and
it applies if (e) is ever relaxed.

**g) Raise Supabase's sign-in rate limit.** Authentication → Rate Limits →
*sign-ups and sign-ins*: **300** per 5 minutes.

Every sign-in reaches Supabase from this server, so its per-IP limit (30 by
default) is one bucket for the whole deployment: a training room of teachers
signing in at once, or one person guessing passwords, would lock everyone out.
The application does the real throttling itself, per account and per client
address (10 failed attempts at one account from one address, 100 failed
attempts from one address, per 15 minutes; a successful sign-in does not
count). The Supabase limit only needs to sit above the whole deployment's
legitimate peak.

### 2.3 Optional: outbound email

SMTP is configured **in Supabase** (Authentication → Emails → SMTP Settings),
not in this application. Until you attach a provider, leave
`AUTH_EMAIL_ENABLED=false`.

While false, magic-link sign-in and self-service password reset are hidden, and
the UI says plainly that password resets go through an administrator. That is
true, and better than accepting an address and promising a message that cannot
be sent. Administrators create accounts with a password at `/admin/users` and
hand it over directly.

When you attach SMTP, do all four of these, then set `AUTH_EMAIL_ENABLED=true`
and redeploy. No code change.

1. **Site URL.** Authentication → URL Configuration → *Site URL*: your
   `APP_URL` (e.g. `https://lms.example.org`). The default is
   `http://localhost:3000`, and every emailed link is built on it.
2. **Redirect URLs.** Same page → *Redirect URLs* → add `APP_URL/auth/**`
   (e.g. `https://lms.example.org/auth/**`). GoTrue silently replaces any
   redirect it does not allow-list with the bare Site URL, so without this the
   link never reaches the application's callback at all.
3. **Reset Password template.** Authentication → Emails → Templates → *Reset
   Password*: make the link
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/login/reset`
4. **Magic Link template.** Same place → *Magic Link*: make the link
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink&next=/dashboard`
   — `magiclink`, not the `email` that Supabase's own examples use: the
   application refuses `type=email`, because Supabase would also accept a
   sign-up confirmation under it.

Steps 3 and 4 are what let a link work on a **different device** from the one
that asked for it. The default templates use a code that can only be redeemed
in the browser that made the request: a teacher who asks for a reset on a
school computer and opens the email on her phone gets "This link has expired".
The `/auth/confirm` links work anywhere. A reset link is good for one use, and
the page it opens only accepts it for 15 minutes. Supabase records a session
from either link the same way, so for those same 15 minutes after a magic-link
sign-in, `/login/reset` will also set a new password without the current one;
that proves no less than a reset link, which anyone who can read the mailbox
can request.

### 2.4 AWS

| Item | Value |
|---|---|
| Instance | `m7i-flex.large` (2 vCPU, 8 GiB) — or `t3.large` in **unlimited** credit mode |
| AMI | Ubuntu Server 24.04 LTS (x86_64). §2.5's commands are written for it. |
| Root volume | 30 GiB gp3 |
| Data volume | 100 GiB gp3 mounted at `/var/lib/gml`: Docker's data root (images, build cache, the worker's ffmpeg scratch — §2.5) and the local dumps |
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

### 2.5 Prepare the instance

`scripts/deploy.sh` runs on the instance itself, and before it builds anything
it needs four host programs: **Docker Engine with the Compose v2 plugin**,
**Node 22**, **pnpm** and **curl**. It checks for all four and names whichever
is missing, but a stock Ubuntu AMI ships only curl. On the instance, as the
`ubuntu` user:

```bash
# Docker Engine + the Compose v2 plugin, from Docker's own apt repository
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"

# Docker's data -- images, build cache and every volume, the worker's ffmpeg
# scratch among them -- goes on the DATA volume, not the 30 GiB root (§2.4).
# First make and mount the data volume at /var/lib/gml; `lsblk` names it
# (usually nvme1n1 on this instance type):
sudo mkfs.ext4 -L gmldata /dev/nvme1n1
sudo mkdir -p /var/lib/gml
echo 'LABEL=gmldata /var/lib/gml ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount /var/lib/gml
# ...then point Docker at it before anything is built or pulled:
sudo mkdir -p /var/lib/gml/docker
echo '{ "data-root": "/var/lib/gml/docker" }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker

# jq: the verification commands in §5 pipe /api/health through it
sudo apt-get install -y jq

# Node 22 (package.json "engines") from NodeSource, and pnpm through corepack,
# pinned to package.json "packageManager"
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
sudo corepack enable
corepack prepare pnpm@10.33.4 --activate
```

**Now log out and back in.** Membership of the `docker` group only takes effect
in a new login session; until then every `docker` command fails with
*permission denied* on `/var/run/docker.sock`. Then confirm:

```bash
docker compose version    # Docker Compose version v2.x
docker info --format '{{.DockerRootDir}}'   # /var/lib/gml/docker
node --version            # v22.x
pnpm --version            # 10.33.4
jq --version
```

No `pnpm install` is needed. Nothing `deploy.sh` runs on the host imports from
`node_modules`. The PostgreSQL client, rclone and the AWS CLI are for backups
and are installed in §7.

---

## 3. First deploy

```bash
# On the instance, after §2.5 and a fresh login
sudo mkdir -p /var/lib/gml && sudo chown "$USER" /var/lib/gml
git clone <repo> gml-lms && cd gml-lms   # the repo root IS the app root
chmod +x scripts/*.sh                    # harmless if set; a zip or scp copy can drop the bit

cp .env.example .env
chmod 600 .env
# Fill in .env — every REQUIRED variable is marked. The stack refuses to start
# without them rather than defaulting to something that looks like it works.

bash scripts/preflight.sh   # read-only; exits non-zero on a blocking failure
./scripts/deploy.sh
```

**Run `preflight.sh` yourself, and fix every FAIL before deploying.** It is the
only thing that checks the host toolchain, the pooler port (§10), the Storage
upload limit (§2.2c), that the `DOMAIN` A record points at *this* instance, and
that ports 80 and 443 are free. `deploy.sh` does **not** run it: it fails when
80 and 443 are already bound, which is true of every later deploy.

`deploy.sh` runs: host-toolchain and `.env` checks → the SM-5 restore-drill
gate (§7; skipped, loudly, on a host's first deploy) → build → migrations, on
their own (nothing serving is touched unless they succeed) → tag the images
that were serving as `:previous` (only those the build changed, so a re-run of
the same code keeps the rollback target) → `up` → wait for health through
Caddy → seed → verify auth → post-deploy smoke.

It is idempotent. Re-running it is the normal upgrade path.

The smoke step fetches `https://$DOMAIN` from the instance itself, so `DOMAIN`
must resolve to this instance from the box, which is the same A record Caddy
needs for its certificate. Where that is not true, set `SMOKE_BASE_URL`. If
smoke fails after health, seed and verify-auth have passed, the stack is up.
The failure is in the acceptance checks, not the rollout.

**Before the second deploy, prove the backups work:** install the backup tools
and run `bash scripts/backup.sh && bash scripts/restore.sh` once by hand (§7).
From the second deploy on, `deploy.sh` refuses to run without a passing restore
drill less than 30 days old.

**Write down the section-gate passwords the seed prints.** They are shown once;
only the hash is stored. You can rotate them later at `/admin/gates`.

---

### 3.1 Clearing the demonstration data

The seed inserts two kinds of row and does not distinguish them. The
**districts and zones are real** Ladakh administrative divisions, and so are
the phases, terms, subjects and form catalogues, and section gates —
keep all of it. (One exception: the three observation-form templates are
stored on the demo cycle `OBS-2026-001`, so they go when it goes. Nothing in
the application reads them, and on every later deploy the seed step prints a
warning that `OBS-2026-001` is gone and carries on — that warning is expected.)

**The seeded phases are dated 2025-04-01 to 2026-09-30.** The dashboard names
the phase whose dates contain today, so extend the programme before the last
one ends: add the next phase and its terms at `/admin/data/phases` and
`/admin/data/terms` (and correct any date there), then attach its RTT
subjects at `/admin/data/rtt-subjects`. New districts are added at
`/admin/data/districts`. A phase, term or district that still has anything
under it cannot be deleted; the grid says what is still attached.

**Quizzes are not seeded.** Each RTT subject page lists the active quizzes
bound to that subject; until someone creates and activates one at
`/admin/quizzes`, the subject's Assessment card reads "No assessments published
yet". Each quiz is bound to an RTT subject when it is created, so the RTT
subjects must exist first, and its address (slug) is its own -- there are no
fixed slugs. That is a task for the programme team before teachers reach the
RTT subject pages. Neither the seed nor the purge touches the quiz tables.

The **schools, teachers, mentors, pairings and observation cycles are
invented**: ten schools with sequential contact numbers, ten teachers with
sequential mobiles (`+91 9419100001..`), two mentors (Dr. Anjali Bhatt and
Prof. Iqbal Hussain), and eight cycles `OBS-2026-001..008`.
Left in place they appear in the roster, in QuickFind, in every admin grid and
in the dashboard counts, indistinguishable from real staff.

```bash
docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/purge_demo_data.ts
```

That is a **dry run** — it lists every cycle, pairing, teacher, mentor and
school it would remove, and every candidate it would keep and why, and changes
nothing. Under the list it counts what goes with those rows: unsubmitted
observation templates, the removed teachers' classroom sessions and RTT
attendance marks, and the demo schools' classes and **learners** (children's
records). Apart from the three templates the seed hangs on `OBS-2026-001`,
the seed writes none of those, so any other count above zero is something
someone entered; check it before going on. Read the list before adding
`--apply` to commit, which runs in a single transaction and removes exactly
what the list names. If a draft is saved on one of the listed rows while it
runs, it stops and removes nothing.

Three things it does deliberately:

- **It keeps the districts.** `seed.ts` skips everything when any district
  exists, and `deploy.sh` runs the seed on every deploy — so removing them
  would reinstate all of this on the next deployment.
- **It matches the seed's exact rows.** Only those ten mobiles and those eight
  cycle codes, and a cycle only when its teacher is one of the ten and has no
  login — so a real cycle created at `/observation/new` (which numbers on from
  the seed's, and starts again at `OBS-2026-001` once they are gone) is never
  caught.
- **It keeps anything with real work attached.** A demo cycle that has acquired
  a genuine form, video, evidence row or draft; a demo pairing with a meeting,
  a feedback response, a quarterly video, commitments or a draft; a demo
  teacher who has been given a login, with all their cycles and pairings; and a
  demo-named mentor record with a login linked to it are all reported and left
  alone. Whatever a kept row cannot exist without — its teacher, its mentor,
  the teacher's school — is kept with it.

Safe to run twice; the second run removes nothing.

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
cd gml-lms && git pull && ./scripts/deploy.sh
```

`git pull` updates the working tree while the old containers keep serving; the
new release is live only once `deploy.sh` finishes. If an upgrade stops in
between (an interrupted session, or `deploy.sh` refusing on a check), finish it
by re-running `./scripts/deploy.sh`. An up-to-date tree is not evidence that
the deploy happened.

If a migration fails, **the previous containers keep serving**: `deploy.sh`
runs the migrations on their own (`docker compose run --rm --no-deps migrate`)
before `docker compose up` touches anything, stops when they fail, and puts
`:current` back on the running images. That is the intended posture: a bad
schema change degrades to "no deploy happened" rather than "the site is down".
(A bare `docker compose up -d` does NOT give you this: it recreates `app` before
it waits for `migrate`.)

### Rolling back

```bash
./scripts/rollback.sh
```

Restarts `app` and `worker` from the `:previous` image. It asks for
confirmation, and refuses when `:previous` is the image already running --
nothing would change.

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
docker compose run --rm --no-deps migrate pnpm exec tsx scripts/verify-auth.mjs

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

`/admin/users`. Set an initial password and hand it over. The first time the
account holder signs in, every page sends them to Settings until they choose a
password of their own; the same happens after you set someone's password for
them. There is no invite email unless you have configured SMTP (§2.3).

The account the seed creates from `SUPER_ADMIN_INITIAL_PASSWORD` is not marked
this way. Change its password in Settings at first sign-in, then delete the
value from `.env`, where it would otherwise remain the most privileged
account's live password.

Deactivating an account does three things: sets the profile inactive (the hook
then refuses to mint tokens), ends the user's sessions on every device, and bans
the auth user so the correct password no longer works. Residual access is the
access token already in their browser — hence §2.2b. Demoting an administrator
also ends their sessions, and their admin access stops at once.

### Logs

```bash
docker compose logs -f app
docker compose logs -f worker
docker compose ps           # health of each container
```

Rotation is already configured, in `docker-compose.yml`'s `x-logging` anchor
that every service uses: **10 MB × 3 files per service**, about 120 MB worst
case across the stack. There is nothing to set up. With no alerting and no
metrics (docs/operations.md), these logs are the only forensic record. For more
history, raise `max-size` / `max-file` in that one anchor, and update the
figure in its header comment and here.

### The transcode queue

`/admin/transcode-jobs` shows queue depth and failed jobs, with Retry and Drop.

A job that has exhausted its attempts is **dead**, not merely failed — the
distinction is what tells you "will be retried automatically" from "needs a
human". A worker killed mid-job has its work requeued by the lease reaper once
its lease lapses: up to 15 minutes after its last heartbeat (see
docs/operations.md). A worker merely stopped or redeployed hands its job back
within seconds.

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
# The PostgreSQL client, from the PGDG repository: Ubuntu's own repository
# stops at an older major than Supabase runs.
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update
sudo apt-get install -y postgresql-client-17 rclone

# The AWS CLI v2, as a snap
sudo snap install aws-cli --classic

# Check the majors: pg_dump's must be AT LEAST the server's.
psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" -XtAc 'SHOW server_version'
pg_dump --version
```

**The client's major must be at least the server's.** pg_dump refuses to dump
a newer server ("aborting because of server version mismatch"), which is how
this runbook's old instruction to install client 16 produced no dump at all
against a Postgres 17 project. Supabase creates new projects on 17 at the time of
writing; if `SHOW server_version` reports a newer major, install that
`postgresql-client-N` instead. You do not have to get this right from memory:
`backup.sh` and `preflight.sh` both ask the server for its major and refuse a
too-old client by name.

Add to `.env`:

- `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`: Project
  Settings → Storage → S3 access keys (the short spellings
  `SUPABASE_S3_ACCESS_KEY` / `_SECRET_KEY` also work)
- `BACKUP_S3_BUCKET`: an S3 bucket you control, e.g. `s3://gml-lms-dr`
- `AWS_REGION`
- `SUPABASE_S3_ENDPOINT` is **optional**: `backup.sh` derives it from
  `NEXT_PUBLIC_SUPABASE_URL`. Set it only for a custom domain.

The DR bucket is written with the **instance's own AWS credentials**. Attach an
IAM role to the instance that allows `s3:PutObject`, `s3:GetObject` and
`s3:ListBucket` on that bucket, or run `aws configure`. Both `aws s3 cp` (the
dump) and rclone (the videos) use it.

```cron
# crontab -e
# PATH first: cron's default is /usr/bin:/bin, which does not include /snap/bin
# where the AWS CLI lives. Without it backup.sh keeps the dump on this host.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
0 2 * * *  cd /home/ubuntu/gml-lms && bash scripts/backup.sh  >> /var/lib/gml/backup.log 2>&1
0 4 * * 0  cd /home/ubuntu/gml-lms && bash scripts/restore.sh >> /var/lib/gml/drill.log  2>&1
```

Then run both once by hand, now, and read what they print:

```bash
bash scripts/backup.sh && bash scripts/restore.sh
```

That first passing drill is also what the deploy gate needs: from a host's
second deploy on, `deploy.sh` refuses to run without one (below).

If the Storage credentials are absent, `backup.sh` **warns loudly on stderr and
continues** rather than failing. Check the log after the first run: a backup that
silently omits the irreplaceable half is worse than one that fails.

### The weekly drill

`scripts/restore.sh` restores the newest dump into a throwaway database,
asserts the schema and row counts look sane, drops it, and stamps
`workspace/last_restore_drill.json`.

**Where the throwaway database comes from.** There is no Postgres server on
this box: Supabase is the database. The drill starts its own, a
`postgres:<major>-alpine` container whose major is read from the dump's own
header, published on `127.0.0.1:55432` only. It is removed when the drill ends,
whether the drill passed or failed. It needs Docker (§2.5) and nothing else.
`DRILL_IMAGE` and `DRILL_PORT` override the image and port. To restore into an
existing throwaway server instead, set `DRILL_HOST`:

```bash
DRILL_HOST='postgres://postgres:secret@127.0.0.1:5432/postgres' bash scripts/restore.sh
```

The database name in `DRILL_HOST` is replaced by `gml_restore_drill`. A
`?sslmode=...` query is kept. A Supabase host, or `DATABASE_URL` itself, is
refused.

**The gate.** `deploy.sh` refuses to deploy when that stamp is missing, older
than 30 days, or records a failed drill. A failed drill stamps
`"result": "failed"` with its reason, and the refusal prints that reason. The
gate is armed on every deploy **except a host's first deploy**, when nothing
can have been backed up yet. It is skipped then, with a message saying what to
run. Exporting `NODE_ENV` as anything other than `production` also skips it,
so do not do that on the production box.

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
4. Re-run the dashboard steps in §2.2 — **hooks and settings are not in the
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
| WhatsApp videos not arriving | The integration is off or partly configured, or a secret or token is wrong | `/api/health` reports `whatsapp: off / partial / on` (`details` names the missing variables); `/admin/whatsapp-log` says the same. Secret unset: 503 `whatsapp_not_configured` (ingest is OFF, by design, until it is set). Secret wrong: 401, `whatsapp.signature_failed` rows and a log line naming `WHATSAPP_APP_SECRET`. Access token missing or expired: videos wait on `/admin/whatsapp-log` with the reason; fix the token, then **Retry fetch**. Check `docker compose logs app worker`. First-time setup: `README-IT.md`, "WhatsApp Business setup". |
| A page is blank with a console CSP error | CSP too strict after a Next upgrade | `buildCsp` in `apps/web/src/lib/csp.ts` (called per request by `apps/web/src/proxy.ts`). Not the Caddyfile — it deliberately sets no CSP. A violation is silent server-side. |
| `deploy.sh` stops at "not healthy after 180s" with no body at all | Caddy has no certificate for `DOMAIN` yet | The A record must point here and port 80 must be open; `docker compose logs caddy` |
| Worker container unhealthy | Cannot reach the database | Check `DATABASE_URL` uses the **session** pooler (port 5432), not transaction (6543) |

### One thing that will look like a bug and is not

`DATABASE_URL` must use Supabase's **session pooler on port 5432**, never the
transaction pooler on 6543. Transaction mode disables prepared statements, which
Drizzle relies on. The symptom is intermittent, confusing query failures under
load rather than a clean error at startup.
