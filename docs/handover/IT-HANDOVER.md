# GML LMS — handover to IT

**Release:** `v1.0.0-rc.1` (first release candidate) · **Repository:** github.com/skunkworks-powerweave/GML
**Split of work:** IT runs the servers, the deploys and QA. The development lead debugs and fixes, and every fix arrives as a new release candidate.

---

## 1. What you are getting

| Item | Where | What it contains |
|---|---|---|
| The application | the repository, tag `v1.0.0-rc.1` | Next.js web app, video worker, database migrations, container definitions |
| Container images | `ghcr.io/skunkworks-powerweave/gml-app`, `gml-worker`, `gml-migrate`, tagged `1.0.0-rc.1` | Built by CI from the tag, after the full test gate passed |
| **This document** | `docs/handover/IT-HANDOVER.md` | Environments, CI/CD, what IT sets up, first-deploy checks, who does what |
| IT quick reference | `README-IT.md` | The 5-step deploy, environment variables, WhatsApp Business setup, day-to-day admin, logs, backups, data retention, troubleshooting |
| Full deployment guide | `README-deploy.md` | Supabase and AWS setup step by step, first deploy, clearing demo data, loading programme data, upgrading, rolling back, verifying, backup and restore, secrets, cost |
| QA plan | `docs/qa/QA-PLAN.md` | Every check per role, with expected results. First-deploy acceptance checks, bug-report format, exit criteria for production |
| CI/CD | `.github/workflows/` | `test.yml` (checks), `release.yml` (tag → images), `deploy.yml` (release → server) |
| Architecture and verification record | `docs/architecture.md`, `docs/verification.md` | How the parts fit, and what has and has not been proven |

## 2. What runs where

One **EC2 instance** per environment runs four containers with `docker compose`: `caddy` (HTTPS, Let's Encrypt), `app` (the website), `worker` (video transcoding with ffmpeg, background jobs) and `migrate` (a one-shot schema step).
**Supabase** (a managed service, one project per environment) holds the database, the logins and the stored files. The WhatsApp Business Cloud API is the second way videos arrive.

| | Staging | Production |
|---|---|---|
| Purpose | QA of each release candidate | Teachers and staff |
| Server | its own EC2 instance (`README-deploy.md` 2.4–2.5) | its own EC2 instance |
| Supabase | its own project | its own **Pro** project (`README-deploy.md` 2.1–2.2) |
| Domain | e.g. `lms-staging.<org>` | e.g. `lms.<org>` |
| Data | demonstration data kept | demonstration data cleared before go-live (`README-deploy.md` 3.1) |
| GitHub environment | `staging` | `production`, with required reviewers |

## 3. CI/CD

```
pull request ──► ci (test.yml): lint · typecheck · build · governance tests
                  · database tests on a real Postgres · container images
merge to main ──► ci again
tag v1.2.3-rc.N ─► release (release.yml): the ci gate again → images to ghcr.io
publish the GitHub Release ─► deploy (deploy.yml) → STAGING, automatically
QA on staging (docs/qa/QA-PLAN.md) ─► fixes → next -rc … until sign-off
tag v1.2.3 (same commit) ─► release ─► publish ─► staging
Actions → deploy → Run workflow (production, v1.2.3) ─► reviewer approves ─► PRODUCTION
```

- **A deploy** runs the documented upgrade on the server over SSH: `git fetch --tags`, check out the tag, `./scripts/deploy.sh`. Then it checks `/api/health` through the public URL.
- **`deploy.sh` protects the running site.** Migrations run before anything serving is touched, and if a migration or build fails the previous containers keep serving. If the new containers then fail their health or smoke checks, the job fails and the site is left on the new version; `./scripts/rollback.sh` returns to the previous images.
- **Rollback** is a deliberate act on the server: `./scripts/rollback.sh` restarts the previous images. It never touches the database; migrations only move forward (`README-deploy.md` 4).
- **Production** takes only final versions, never an `-rc`, and only a hand-started run that a named reviewer approves.

## 4. What IT sets up

**Per environment (staging first, then production):**

1. **AWS.** Create the instance and its data volume, then prepare it (`README-deploy.md` 2.4, 2.5). Point the domain's DNS at it and open ports 80 and 443.
2. **Supabase.** Create the project and do the three dashboard steps (`README-deploy.md` 2.1, 2.2). Outbound email is optional but needed for password reset (2.3).
3. **The first deploy, by hand, on the server** (`README-IT.md`, 5-step deploy): `git clone`, fill `.env` (every required key is marked), `bash scripts/preflight.sh`, `./scripts/deploy.sh`. Keep the section passwords the seed prints; they are shown once.
4. **Backups.** Add the `backup.sh` cron and schedule the weekly restore drill (`README-deploy.md` 7). **From the second deploy on, `deploy.sh` refuses to run without a restore drill in the last 30 days.**
5. **A deploy account for CI.** On the server, a user that owns the checkout and can run Docker, with an SSH key made only for this, authorised for that user.
6. **The GitHub environment.** Repository → Settings → Environments → `staging` or `production`:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `DEPLOY_HOST` | the server's address |
   | Secret | `DEPLOY_USER` | the deploy account |
   | Secret | `DEPLOY_SSH_KEY` | that account's private key |
   | Secret | `DEPLOY_KNOWN_HOSTS` | the server's host key line (`ssh-keyscan <host>`, checked against the server's own fingerprint) |
   | Variable | `DEPLOY_PATH` | the checkout on the server, e.g. `/home/gml/gml-lms` |
   | Variable | `DEPLOY_URL` | `https://<domain>` |

   On **production**, also turn on **Required reviewers** (the programme owner and an IT lead), and under *Deployment branches and tags* allow only `main` (a production deploy is started from `main` and names the tag to deploy).

Until an environment has these, publishing a release says so in the Actions log and deploys nothing.

## 5. First-deploy acceptance

These have not been proven on real infrastructure. They are QA-ACC-01 to 06 in the QA plan:

- a Let's Encrypt certificate on the real domain;
- `verify-auth.mjs` passing against the real Supabase project;
- a password-reset email reaching a real mailbox;
- a real WhatsApp video from Meta, end to end;
- a backup reaching S3, and a passing restore drill;
- a repeat deploy through CI.

## 6. Time-sensitive, and still needed

**The seeded programme phases end on 2026-09-30.** After that date the dashboard names no current phase until the next phase and its terms are added at `/admin/data/phases` and `/admin/data/terms`, and its RTT subjects at `/admin/data/rtt-subjects` (`README-deploy.md` 3.1). Do this on every environment, as part of loading the programme's data.

**WhatsApp stays switched off until the Meta keys are added.** WhatsApp is how teachers send videos on low bandwidth. It is built, and until these keys are set the webhook refuses all traffic while the rest of the app works (videos arrive by direct upload only). It needs four values from the programme's Meta Business account, put in each server's `.env`, and then the webhook registered in Meta (`README-IT.md`, WhatsApp Business setup):

| `.env` key | From Meta |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → Phone number ID (not the phone number itself) |
| `WHATSAPP_APP_SECRET` | App settings → Basic → App secret |
| `WHATSAPP_ACCESS_TOKEN` | a **permanent** token: Business settings → Users → System users. The token on the API Setup page expires after 24 hours, and with it no video can be downloaded. |
| `WHATSAPP_VERIFY_TOKEN` | any long random string you choose; Meta sends it back once, when the webhook is registered |

Whoever manages the programme's Meta Business account creates these. IT adds them to `.env`, redeploys, and registers the webhook. Acceptance check QA-ACC-04 waits for them.

## 7. Known gaps in this release

- The **Hindi and Bhoti** text is machine-drafted and needs a native speaker's review before teachers see it (`docs/i18n-glossary.md`).
- Teach-backs that arrive **by WhatsApp** are not queued for review automatically. They still show in Pending review, and deciding them there works.
- The **approvals badge** is on desktop only. Phones reach Approvals through Menu, without a count.
- The **My teaching** hub is reached from the teacher's dashboard card, not the menu.
- PDFs uploaded in the data tables are limited to **9 MB**.
- The hosted Supabase project used during development (`zhoqmywalkiujmozcjws`) is 16 migrations behind. Use a fresh project per environment, or treat that one as staging after a backup.

## 8. Reporting and fixes

1. QA reports each failure in the format at the end of the QA plan, quoting its check ID.
2. The development lead reproduces it, fixes it with a test, and opens a pull request. CI must pass before it merges.
3. A new release candidate (`-rc.N`) is tagged and published. Staging updates itself, and QA re-runs the affected checks.
4. At sign-off, the final version is tagged and deployed to production with approval.

**Contacts:** development lead `<name, email>` · IT lead `<name, email>` · programme owner `<name, email>`
