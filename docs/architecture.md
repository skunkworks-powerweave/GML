# Architecture

What this system is made of and why. Deployment mechanics live in
[`../README-deploy.md`](../README-deploy.md); this is the reasoning behind the
shape.

---

## The shape

```
                    Route 53 ── ACM / Let's Encrypt
                        │
                 ┌──────▼──────┐  EC2 · ap-south-1 · 2 vCPU
                 │    caddy    │  TLS, reverse proxy, CSP
                 │      │      │
                 │  ┌───▼───┐  │        ┌──────────────────────┐
                 │  │  app  │──┼───────▶│ Supabase ap-south-1  │
                 │  └───────┘  │        │  Postgres · Auth ·   │
                 │  ┌───────┐  │        │  Storage             │
                 │  │worker │──┼───────▶│                      │
                 │  └───────┘  │        └──────────┬───────────┘
                 │  (migrate)  │                   │
                 └─────────────┘   browser ────────┘
                                   uploads TO and streams FROM
                                   Storage directly
```

Four containers. Everything stateful is Supabase's.

**The most important line on that diagram is the dashed one.** Video does not
transit the application server in either direction:

- **Uploads** go browser → Supabase Storage over TUS, authenticated with the
  user's own access token and bounded by an RLS policy that pins the object key
  to their uuid.
- **Playback** fetches segments from Supabase's CDN using signed URLs embedded
  in the playlist. The app generates the playlist; it never serves a byte of
  video.

For a 20-minute lesson that is ~200 requests and hundreds of megabytes per
viewer that EC2 does not proxy. It is the single biggest factor in instance
sizing, and it is also cheaper — AWS ap-south-1 egress is ~$0.109/GB against
Supabase's $0.09.

---

## Why Supabase rather than self-hosted

The original design was eight containers on one VPS: Postgres, Redis, MinIO,
minio-init, tusd, app, worker, Caddy. Three things pushed it over.

**MinIO withdrew their public Docker images.** Not the pinned tag — the entire
`minio/*` namespace. Since `app` and `worker` both declared
`depends_on: minio: service_healthy`, nothing in the stack could start, on any
machine. That is not a dependency you can keep.

**The operator is an IT team with other work.** Every self-hosted service is a
thing to patch, back up, monitor and be paged about. Postgres, Redis and MinIO
are three such things for a system with fifty users.

**Auth was the largest source of defects.** The hand-rolled parts — a lockout
state machine, a password-reset token table, a magic-link provider — accounted
for more security bugs than everything else combined. See `substrate-moats.md`
and the commit history.

What Supabase does NOT solve, recorded so nobody assumes otherwise: it has **no
backup product for Storage**, point-in-time recovery is a paid add-on not
included in Pro, and two required configuration steps exist only in its
dashboard with no SQL equivalent. See README-deploy.md §2.2 and §7.

---

## Identity

```
auth.users        (Supabase: email, encrypted_password, sessions, MFA)
    ↑ 1:1, id
public.users      (profile: role, active, name, phone, locale, deleted_at)
```

`public.users.id` is a foreign key to `auth.users(id)`, **ON DELETE RESTRICT**.

The uuid is preserved across the boundary because 19 foreign keys point at
`public.users(id)` and none are `ON UPDATE CASCADE` — so ids originate in
`auth.users` and the profile adopts them, never the reverse.

RESTRICT rather than CASCADE is deliberate: cascading would run through
`public.users` into `quiz_submissions`, `form_drafts`, `notifications`,
`user_prefs` and `section_gate_grants`, destroying programme data from a
dashboard button, silently, and bypassing the `deleted_at` soft-delete the
schema already implements.

### The access-token hook is the whole design

`public.custom_access_token_hook` runs every time GoTrue mints an access token —
at sign-in **and on every refresh**. It reads the profile and either injects
`user_role` into the claims or returns a 403 and mints nothing.

That single function is both the role source and the revocation point:

| It refuses when | Which means |
|---|---|
| no profile row | self-registration is inert — an `auth.users` row alone gets no token |
| `active = false` | deactivation is honoured on every path, not just the one that checked it |
| `deleted_at` set | soft-deleted staff cannot sign in |

Because it runs on refresh, the stale-role window is one access-token lifetime
rather than the eight hours the previous JWT gave. The claim is named
`user_role`, **not** `role` — `role` is reserved, carrying the Postgres role
that PostgREST and RLS switch into.

**It has to be enabled in the dashboard.** Until it is, no token carries
`user_role`, `auth()` returns null for everyone, and nobody can sign in. That is
fail-closed and correct, and it is the most commonly missed step;
`scripts/verify-auth.mjs` exists to say so plainly.

---

## Authorization, in four layers

Each answers a different question. They are not redundant.

| Layer | Question | Where |
|---|---|---|
| `proxy.ts` | is anyone signed in, and does their role reach this URL prefix? | catch-all matcher |
| `lib/guards.tsx` | does this page's role requirement hold? | server components |
| `lib/api-guards.ts` | same, but answering with a status a fetch caller can branch on | route handlers |
| `lib/authz.ts` | may **this** person touch **this** object? | every detail page and mutation |

`proxy.ts` is explicitly **not** the boundary. Next's own reference notes that
Server Functions are POSTs to the route that hosts them, so a matcher edit can
silently remove proxy coverage from a mutation. Its first job is not
authorization at all — it is the only request path that can persist a rotated
refresh-token cookie, because Server Components cannot write cookies.

Object-level failures return **404, not 403**. A 403 on
`/observation/<uuid>` confirms the uuid names a real cycle, which is exactly
the enumeration a guessed-uuid attack wants.

Role checks are **exact set membership**. They were a `>=` comparison against a
rank map, which made every `requireRole([...])` a minimum-rank floor: `observer`
and `mentor` both ranked 2 and satisfied each other, and any list containing
`teacher` admitted every authenticated user.

---

## Video pipeline

```
 browser ──TUS──▶ Storage:videos-original ──┐
                                            ├──▶ jobs ──▶ worker ──▶ ffmpeg
 WhatsApp ──webhook──▶ Storage ─────────────┘                          │
                                                                       ▼
                        Storage:videos-hls (index.m3u8 + seg_*.ts) + posters
                                                                       │
 browser ◀── playlist with signed segment URLs ◀── /api/media/playlist/[id]
 browser ◀────────────── segments, from Supabase CDN ───────────────────┘
```

**Playlist rewriting is what makes playback work at all.** ffmpeg writes bare
segment names, so a player loading the playlist from `/api/media/...` resolves
`seg_00000.ts` relative to that URL and 403s on the first segment. The playlist
route fetches the real playlist, batch-signs every segment in one round trip
(measured: 200 keys in 43 ms) and returns absolute URLs.

Server-side rewriting rather than a custom hls.js loader, because Safari and iOS
play HLS natively and never consult a JS loader — and field mentors are a
primary iOS audience.

Signed-URL lifetime scales with duration:
`min(max(duration*3 + 900, 1800), 21600)` seconds. A fixed TTL forces a choice
between a viewer who pauses returning to a dead player and a URL copied out of
devtools working for hours.

---

## Queue

A `jobs` table, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. Throughput is
under 100 jobs/day; this handles that with five orders of magnitude to spare.

Leases with a heartbeat replace BullMQ's stalled-job detection. Both halves
matter: without a lease a hard-killed worker leaves a job `running` forever, and
with a plain timeout instead of a heartbeat a legitimate 40-minute ffmpeg run
gets reaped mid-flight and transcoded repeatedly until it dead-letters.

Producer idempotency is a **partial** unique index over live jobs only. Scoping
it that way is what lets an operator re-enqueue a job that has already finished
— a plain unique index would make the Retry button impossible forever.

`transcode_jobs` is kept separate and keeps its meaning: it is the per-attempt
domain ledger `/admin/transcode-jobs` renders. `jobs` is the transport.
Conflating them is what produced `bull_job_id`, a column four files read and
nothing ever wrote.

---

## What is deliberately NOT here

- **RLS as the primary access control.** The app connects as the table owner,
  which bypasses RLS entirely. Making it engage needs a non-owner role,
  `FORCE ROW LEVEL SECURITY`, and every user-scoped query wrapped in a
  transaction setting a request-scoped GUC. RLS here is defence-in-depth against
  the Data API, not the control — `lib/authz.ts` is. Said plainly because "we'll
  add RLS later" must not become a reason to skip ownership checks.
- **Multi-tenancy.** One programme, one deployment.
- **Horizontal scaling.** One instance. The queue would tolerate more workers;
  nothing else has been designed for it.
- **Alerting and metrics.** See `operations.md`, "What is NOT monitored".
