# Substrate moats

Invariants this codebase defends at more than one layer. Violating one requires
explicit sign-off, not a judgement call in a pull request.

This document was a five-line placeholder saying "real content lands in spec
011". Meanwhile **SM-7, SM-8 and SM-9 were invoked as load-bearing constraints
in roughly 40 source files and defined nowhere** — their only definitions were
incidental prose inside individual spec folders. A constraint that forty files
cite and no document defines is not a moat; it is a phrase people repeat.

Each entry below states what the invariant is, **where it is actually
enforced**, and — where relevant — where it was NOT enforced despite the
comments saying so.

---

## SM-1 — the audit log is append-only

**Invariant.** A row in `audit_log` is never updated and never deleted. It
records what was true at the time and is not revised afterwards.

**Enforcement.**

| Layer | Mechanism |
|---|---|
| Database (load-bearing) | `BEFORE UPDATE` and `BEFORE DELETE` triggers that unconditionally raise. `_post/001_revoke_audit_writes.sql` |
| Database (privileges) | `REVOKE UPDATE, DELETE, TRUNCATE` from `PUBLIC` and, on Supabase, explicitly from `anon`, `authenticated`, `service_role` — an explicit grant is not removed by revoking from PUBLIC. `_post/001`, `_post/002` |
| Test | `tests/behaviour/invariants.test.ts` issues a real UPDATE and a real DELETE and requires the database to refuse both. Mutation-checked: dropping the triggers fails the test. |

**What fought it.** `audit_log.user_id` was declared `REFERENCES users(id) ON
DELETE SET NULL`. "SET NULL" is implemented as an UPDATE — which the
append-only trigger rejects. So **any user who had ever done anything became
permanently undeletable**, and the error talked about an append-only table,
which is not an obvious place to go looking when you are trying to offboard a
member of staff. Migration `0023` removed the foreign key entirely. Every
referential action was wrong here: SET NULL mutates an immutable table AND
destroys attribution, CASCADE lets deleting a user erase their own trail, and
RESTRICT is the undeletable-user bug with a clearer message.

**Consequence, stated plainly.** `audit_log.user_id` may reference a user who no
longer exists. That is intentional — it is what preserves attribution across a
deletion, which is exactly what you want when investigating. Readers must LEFT
JOIN, never INNER JOIN.

---

## SM-2 — section-gate grants expire

**Invariant.** No section-gate grant outlives 8 hours.

**Enforcement.** A CHECK constraint on `section_gate_grants`:
`expires_at <= granted_at + interval '8 hours'`. The database will not store a
longer one.

**What was broken for months.** The constraint was real and the gate did not use
it. Access was decided by comparing a cookie named `gml-gate-<slug>` to the
literal string `"1"` — unsigned, not bound to a user, never checked against
`section_gate_grants`. `getActiveGrant()` existed, was correct, and had **zero
call sites**. Two consequences: sending the header by hand walked straight in,
and rotating a section password revoked **nobody**, because the decision never
read the rows that rotation deletes.

Enforcement now lives in the gated segments' server layouts
(`assertSectionGate` → `getActiveGrant`). It is deliberately **not** duplicated
in `proxy.ts` as a fast path: a cookie hint produces false negatives, denying a
user who holds a valid grant but no cookie. One authority, one answer.

---

## SM-3 — derived video output is not deleted while it is referenced

**Invariant.** HLS output for a submission is removed only when the submission
itself is being removed.

**Status: enforced in application code, NOT at the database.**

This is stated plainly because the previous claim was false. `videos.ts` carried
the comment "Enforced at the SQL trigger layer"; no such trigger existed in
`_post/`, and the predicate the docstring described was **unsatisfiable** — it
required `files.status = 'ready'`, while the CHECK constraint permits only
`uploading | stored | failed | quarantined`. A moat with an impossible predicate
and no trigger is not a weakened moat; it is an absent one that reads as
present.

What exists today: `removeDerivedOutput()` in `apps/worker/src/transcode.ts` is
the only code that deletes HLS objects, and it is called only from the retention
path. Storage RLS grants DELETE on `videos-original` to the uploader's own
prefix and grants nothing at all on `videos-hls`, so a user cannot delete
transcoder output even by talking to Storage directly.

**Honest gap:** the service role can still delete anything. A database-level
guard would need a trigger on `storage.objects`, which is a separate piece of
work and is recorded here rather than claimed.

---

## SM-4 — reading material is deterred from casual download

**Invariant.** PDFs render in-browser with a viewer-identifying watermark; the
UI does not hand out a clean copy.

**Enforcement.** `/api/media/pdf/[id]` proxies the bytes behind a session check
and sets `Content-Disposition: inline`. Deliberately a proxy rather than a
redirect to a signed Storage URL: a redirect leaves a working, shareable link in
the address bar and browser history for a document the UI stamps
OBS-CONFIDENTIAL.

**This is deterrence, not DRM, and the UI says so out loud in its own footer.**
Anyone determined can screenshot. The moat is that the casual path — right-click,
Save As — does not produce an unwatermarked file.

---

## SM-5 — backups are proven restorable

**Invariant.** A restore drill has succeeded within the last 30 days, or a
production deploy is refused.

**Enforcement.** `scripts/restore.sh` restores the newest dump into a throwaway
database, asserts ≥40 tables and ≥1 user actually landed, and stamps
`workspace/last_restore_drill.json`. `scripts/check-restore-drill.mjs` reads the
stamp and `scripts/deploy.sh` runs it first.

**Scope, stated honestly.** The drill covers the **database only**. The stamp
reports `"storage_verified": false`, because the object mirror is not exercised
by it. The previous version stamped a blanket `"result": "ok"` while testing
only the database — certifying a recovery capability nobody had tested. Supabase
has **no backup product for Storage at all**, so the videos are the half that
matters most and the half the drill does not cover. See README-deploy.md §7.

---

## SM-6 — migrations are forward-only and ordered

**Invariant.** Schema changes are applied in a fixed order, exactly once, and
recorded.

**Enforcement.** Drizzle's journal for numbered migrations, plus a
`_post_migrations_applied` ledger for the raw-SQL lane, each applied inside a
transaction by `packages/db/scripts/migrate.ts`. A failed `migrate` exits
non-zero, and `app`/`worker` block on it via
`depends_on: service_completed_successfully` — so a bad schema change degrades
to "no deploy happened" rather than "the site is down".

**Verified**: the full set applies from an EMPTY `postgres:16.4-alpine`,
producing 43 tables with RLS on all 43. That was not true before — migration
`0000` declared `users_email_unique` as both a CONSTRAINT and an INDEX, so a
fresh database aborted with `42P07 relation already exists`. The schema had
never been created from scratch anywhere, and nobody knew.

---

## SM-7 — Hindi and Ladakhi fields are always optional

**Invariant.** Every `hindi_name`-style column is NULLABLE, and no flow requires
a non-English value to proceed.

**Why.** Staff records are entered by administrators from whatever a teacher
supplied. Making a Devanagari or Tibetan-script field mandatory would block
onboarding on a transliteration nobody has, and would push people to type
placeholder text into a field the UI later renders as a person's name.

**Enforcement.** Column nullability in `packages/db/src/schema/**`; no
server-side validator marks a localised field required.

---

## SM-8 — notifications are retained for at most 90 days

**Invariant.** `notifications` rows older than 90 days are deleted.

**Why.** They accumulate per user per event and are read once. Unbounded, they
become the largest table in the database and the slowest query on the dashboard,
for data nobody will look at again.

**Enforcement.** `deleteOldNotifications()` in
`packages/db/src/scripts/retention.ts`, run nightly by the worker as a queued
job (`dedupeKey: retention:<YYYY-MM-DD>`, gated on `RETENTION_HOUR_UTC`).

Being a queued job rather than a cron registration means it inherits leases,
retries and the dead-letter view — so a retention sweep that fails is visible at
`/admin/transcode-jobs` rather than silently not happening.

---

## SM-9 — every read of learner PII is attributable

**Invariant.** Reading a page that exposes learner personal data writes an audit
row naming who read it.

**Why.** `learners` carries children's names, ages and guardian details. The
control that matters for that data is not "who can read it" — programme staff
legitimately can — but "we know who did".

**Enforcement.** `recordAudit` calls on the learner surfaces and the bulk
exports, plus the `admin.user.surface_viewed` and `resource.pdf.view` actions.
Action names are documented in `docs/audit-actions.md`.

**What weakened it, and what remains.** The Data API exposed **all 47 tables to
anonymous callers** on the hosted Supabase project, including `learners`, using
the anon key that ships in every browser bundle — verified against the live
project while the tables were still empty. `_post/002` closed it at both the
privilege and RLS layers, and the exposed-schema setting closes it at the
gateway. A `tests/behaviour` assertion now requires RLS on every public table.

Residual gap, recorded rather than claimed: `AntiDownloadGuard` beacons
screenshot attempts to `/api/audit/client`, **which does not exist**. The UI
claim "Screenshots are logged" is therefore false. Either implement the endpoint
or remove the claim — it is tracked as outstanding, not defended.
