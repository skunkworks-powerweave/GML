# GML LMS — IT quick reference

**The authoritative deployment document is [`README-deploy.md`](README-deploy.md).**
It carries the Supabase prerequisites, the two manual dashboard steps the
application does not work without, sizing, cost, backup and restore, and the
full troubleshooting table. Read it before a first deploy.

This file is the short version: what runs, how to deploy it, and the four or
five things an IT person actually does after go-live. Anything that would be a
second copy of `README-deploy.md` is a pointer instead — two operator documents
that overlap will drift, and drift is what made the previous version of this
file describe a system that no longer existed.

---

## What runs on the box

Four compose services on one EC2 instance. That is the whole stack.

| Service | Role |
|---|---|
| `caddy` | TLS and reverse proxy. The only published ports (80/443). |
| `app` | Next.js — HTML, RSC, API. |
| `worker` | ffmpeg transcoding, queue consumer, periodic sweeps. |
| `migrate` | One-shot. Applies the schema, then exits. `app` and `worker` block on it exiting 0. |

Everything stateful is **Supabase** — database, authentication and object
storage. The box holds no database and no object store, and video bytes never
transit it in either direction: uploads go browser → Supabase Storage, and
playback segments are fetched by the browser from Supabase's CDN through signed
URLs. That is why a 2-vCPU instance is enough for a video product.

The header of [`docker-compose.yml`](docker-compose.yml) records what each
removed service was and why it went. If someone asks where the database
container went, that is the answer, at the source.

## 5-step deploy

```bash
# 1. Supabase: create the Pro project, then do the two dashboard steps in
#    README-deploy.md 2.2. Nobody can sign in until the first one is done.

# 2. Pull the release onto the instance
git clone <repo> gml-lms && cd gml-lms   # the repo root IS the app root

# 3. Configure
cp .env.example .env && chmod 600 .env
nano .env        # every REQUIRED key is marked in the file

# 4. Deploy
./scripts/deploy.sh          # or: make deploy

# 5. Verify
curl -s https://$DOMAIN/api/health | jq
```

Step 4 runs: preflight (including the SM-5 restore-drill gate), tag the running
images `:previous`, build, `docker compose up -d`, wait for health through
Caddy, seed, verify auth, post-deploy smoke.

**Migrations are not a separate step.** The `migrate` service runs them and
gates `app` and `worker` through `depends_on: service_completed_successfully`.
If a migration fails, the new containers never start and the previous ones keep
serving. Write down the section-gate passwords the seed prints — they are shown
once.

Upgrading is the same command: `git pull && ./scripts/deploy.sh`. Rolling the
application back is `./scripts/rollback.sh`, which restarts `app` and `worker`
from the `:previous` image and does **not** touch the database. See
`README-deploy.md` section 4.

### Manual fallback

When `deploy.sh` aborts and you want to take it apart by hand:

```bash
docker compose up -d                        # migrate runs first and gates the rest
docker compose logs migrate                 # why the schema step failed
docker compose run --rm --no-deps migrate pnpm exec tsx scripts/migrate.ts
docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/seed_all.ts
docker compose run --rm --no-deps migrate node scripts/verify-auth.mjs
```

Doing this by hand bypasses the SM-5 restore-drill gate. Only do it on a host
where `./scripts/restore.sh` has run in the last 30 days, or knowingly accept
that risk.

**The one command that does not work.** Older runbooks — and every earlier
version of this file — said to run `docker compose exec app pnpm --filter @gml/db migrate`.
It cannot work and never could: the `app` image is a Next.js standalone build
containing no pnpm, no tsx and no `packages/db`. Schema work runs in the
`migrate` image, which is built for exactly that. If you find that command
written down somewhere, the note is stale, not the system.

## Environment

`.env.example` is reconciled against the code: every variable it lists is read
somewhere, and everything the code reads is listed. Treat it as the reference;
this is only the operator-facing subset.

| Key | Notes |
|---|---|
| `DOMAIN` / `ACME_EMAIL` | The domain must already resolve here before the first deploy — Caddy needs it for the certificate. |
| `DATABASE_URL` | Supabase **session** pooler, port 5432. Not the transaction pooler on 6543. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Project origin and the browser-safe key. |
| `SUPABASE_SECRET_KEY` | Bypasses RLS entirely and can create, ban and delete accounts. Never let it reach a browser. |
| `AUTH_EMAIL_ENABLED` | `false` until SMTP is attached in the Supabase dashboard. See "Accounts and passwords" below. |
| `WHATSAPP_APP_SECRET` | Required. The webhook refuses **all** traffic without it — by design. |
| `WHATSAPP_VERIFY_TOKEN` | Must match what you type into the Meta dashboard during webhook setup. |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` | From Meta Business Manager. |
| `GML_WHATSAPP_NUMBER` | Display E.164 shown on the upload pages as the "send your clip here" hint. |
| `GML_HELPDESK_PHONE` | wa.me-ready E.164 without the plus, for the in-product Help button. |
| `GML_HELPDESK_EMAIL` | mailto target for the same Help button. |
| `WORKER_CONCURRENCY` | **1.** One ffmpeg at `-preset veryfast` saturates both vCPUs; a second starves the web tier sharing the box. |
| `TZ` | IANA zone, `Asia/Kolkata`. Pins the worker's sweeps and audit-log timestamp interpretation. |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_INITIAL_PASSWORD` | Used once, by the seed, to create the first usable account. |

## Day-to-day

### Admin surfaces

Reachable from the left rail for `super_admin` and `programme_admin`, or by
typing the URL.

- **`/admin/users`** — create an account, set an initial password, change a
  role, deactivate someone. This is the only way to onboard a teacher, and it
  is where a forgotten password is dealt with. Deactivating ends the user's
  sessions on every device and bans the auth user; the access token already in
  their browser expires on its own, which is why `README-deploy.md` section 2.2b
  tells you to set the token lifetime to 900 seconds.
- **`/admin/quizzes`** — quiz catalog and an in-browser editor for the question
  schema. Fixing a typo in a question does not invalidate existing attempts.
- **`/admin/transcode-jobs`** — queue depth and failed jobs, with **Retry** and
  **Drop**. A job that has exhausted its attempts is dead, not merely failed;
  that distinction is what separates "will retry itself" from "needs a human".
- **`/admin/system-settings`** — programme name, academic-year label, default
  video quality, and which inbox notification types are on globally.
- **`/admin/whatsapp-log`** — recent WhatsApp ingest events: signature failures,
  replay-ignores, media fetch results, unmatched context.
- **`/admin`** and **`/admin/data/<table>`** — the no-code tables: schools,
  teachers, mentors, pairings, classes, learners, sessions, course outlines,
  resources, RTT modules / lessons / readings / sessions, observation cycles and
  the rest, each with add, edit, delete, **Import CSV** and **Export CSV**. This
  is how a programme's data gets in: a fresh deployment's Repository reads zero
  until it is loaded. CSVs reference parent rows by UUID, which you get from the
  parent's Export CSV (first column `id`); the procedure and a load order are in
  `README-deploy.md` section 3.2.
- **`/observation/new`** — nominate an observation cycle (teacher and observer
  pickers; the code is assigned). The only other way to create one is the
  `observation-cycles` table above, for bulk loads.

### Accounts and passwords

**Self-service password reset is off by default** (`AUTH_EMAIL_ENABLED=false`).
Outbound mail is configured in the Supabase dashboard, not in this application,
and attaching a provider has been deferred to IT. While it is off, the reset
page says plainly that resets go through an administrator — which is true, and
better than accepting an address and promising a message that cannot be sent.

So the procedure is: an administrator sets a password at `/admin/users` and
hands it over; the account holder changes it in Settings. When you do attach a
relay in the Supabase dashboard, set `AUTH_EMAIL_ENABLED=true` and redeploy. No
code change.

**There is no per-account lockout, and you cannot lock or unlock anyone.** The
hand-rolled lockout this file used to document — a counter on the user row, a
timed block, and an admin endpoint to lift it — was deleted along with its
columns. It was a denial-of-service tool in both directions: anyone who knew an
address could block it at will with wrong passwords, the counter never decayed
so a single further guess after expiry re-blocked it indefinitely at one request
an hour, and the distinctive error told a stranger which addresses had accounts.
Supabase Auth rate-limits sign-in centrally, with no flag a stranger can set on
someone else's behalf. If a user genuinely cannot get in, set them a new
password at `/admin/users`.

### Logs and health

```bash
docker compose ps                # health of each container
docker compose logs -f app
docker compose logs -f worker
curl -s https://$DOMAIN/api/health | jq
```

`/api/health` reports `ok`, `app`, `db`, `storage`, `migrations`,
`migrationsApplied` and `migrationsExpected`, and returns **503** when anything
is false. It used to return 200 with `ok:false`, which meant the container
healthcheck and the deploy script — both of which read only the status code —
called a stack with no schema healthy.

Set up Docker log rotation once (`README-deploy.md` section 6); the default
`json-file` driver grows without bound.

## Backups (SM-5)

Supabase Pro covers the database daily with 7-day retention. **It has no backup
product for Storage at all** — the videos are a year of classroom recordings
that cannot be re-made, and if we do not mirror them, nobody does. That is what
`scripts/backup.sh` is for.

```cron
0 2 * * *  cd /home/ubuntu/gml-lms && ./scripts/backup.sh  >> /var/lib/gml/backup.log 2>&1
0 4 * * 0  cd /home/ubuntu/gml-lms && ./scripts/restore.sh >> /var/lib/gml/drill.log  2>&1
```

`scripts/restore.sh` is the drill: it restores the newest dump into a throwaway
database, asserts the schema and row counts look sane, drops it, and stamps
`workspace/last_restore_drill.json`. `deploy.sh` refuses to deploy in production
if that stamp is missing or older than 30 days. Restoring for real is
`README-deploy.md` section 7 — and step 4 there, re-doing the dashboard steps,
is the one people miss.

## Security notes (substrate moats)

- **SM-1**: `audit_log` is append-only at the database layer — UPDATE and DELETE are revoked, so not even an application bug can rewrite history.
- **SM-4 (anti-download)** is **deterrence, not prevention**. Watermarks, signed URLs and suppressed right-click stop casual sharing. Screen capture and proxy interception still work; there is no DRM here. Say so to users rather than implying otherwise.
- **SM-7**: Hindi and Bodhi name fields are always optional — never add a NOT NULL constraint to one.
- **SM-9**: reading the learners table writes an audit row automatically, and bulk CSV export requires `super_admin`.

## Troubleshooting

The full table is `README-deploy.md` section 10. The four that account for most
calls:

| Symptom | Cause | Fix |
|---|---|---|
| Nobody can sign in, correct passwords rejected | The Supabase access-token hook is not enabled | `README-deploy.md` 2.2a. Confirm with `docker compose run --rm --no-deps migrate node scripts/verify-auth.mjs`. |
| `/api/health` returns 503 | Read which of `db`, `storage`, `migrations` is false | `docker compose logs migrate` first — it is usually that. |
| Worker unhealthy, videos stuck transcoding | It cannot reach the database, or ffmpeg failed | Check `DATABASE_URL` uses the session pooler (5432); then `/admin/transcode-jobs`. |
| WhatsApp videos not arriving | `WHATSAPP_APP_SECRET` wrong | The webhook refuses all traffic without the right secret. Look for the refusal line in `docker compose logs app`. |

## Support

Internal — contact the Goldenmile platform team.
