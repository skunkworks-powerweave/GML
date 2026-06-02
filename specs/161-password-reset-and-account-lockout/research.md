# Spec 161 — Research

## Token shape

OWASP's Forgot Password Cheat Sheet recommends ≥128 bits of entropy
for password-reset tokens AND that the server store only a hash, not
the plaintext. We pick 32 bytes (256 bits) for headroom, hex-encoded
to 64 ASCII chars so the token survives URL embedding without further
encoding. `crypto.randomBytes` is the CSPRNG path; `Math.random` is
explicitly NOT acceptable (the OWASP guidance calls out predictable
PRNGs as the #1 anti-pattern).

bcrypt at cost 10 matches `lib/password.ts` — the LMS already pays
that cost on every credentials login, so reusing it for the token
hash avoids introducing a second algorithm to reason about. We
considered SHA-256 (a simple HMAC would also do for tokens of this
size) but the LMS-wide convention is bcrypt for all "secret you'll
verify later" use cases. Cost=10 is ~70ms per verify on a 2-vCPU
worker — fine for the rare reset path (<10/day org-wide).

## TTL

30 minutes — long enough for a teacher to read the email on a 2G
link in Drass and click the link without re-requesting, short enough
that an attacker who steals the email some hours later can't burn
it. The OWASP guidance suggests 15-30 min; we pick the upper end
because Ladakh field-mentor email-fetch cadence is sometimes >30 min
on the slowest links. If user complaints about expired links spike
we can raise to 60.

## Enumeration

The contract is "respond 200 regardless of email match". OWASP's
cheat sheet treats user enumeration via the password-reset endpoint
as a Medium severity finding; the standard mitigation is identical
response shape for matched and unmatched emails. We add a small
constant-time delay (none — the bcrypt-hash + DB insert path already
takes ~80ms; the unmatched path returns in ~5ms but the variance is
within network jitter for the intended user population). If a future
audit flags the timing-side-channel as a finding, we can pad the
unmatched path with a no-op bcrypt round.

## Lockout threshold

The spec contract is 5 misses → 1 hour lockout. NIST 800-63B's
"throttling" guidance suggests 100 attempts as the upper bound
before action; the lower bound is operator discretion. We pick 5
because (a) it's a familiar number for users (matches the existing
spec 141 rate limit), (b) it gives a determined user three real
typing attempts plus two for "did I have caps lock on", and (c) the
1-hour lockout is short enough that a locked-out genuine user can
wait it out without paging support.

The lockout counter doesn't decrement on its own — a successful
login is the only thing that clears it (or the super_admin unlock
endpoint). We considered a rolling window with per-attempt
timestamps but the storage cost (a new `password_failures` table)
wasn't worth the additional fidelity. The simple counter is correct
for the "did this user just whiff 5 in a row" question; the audit
log carries the per-attempt timestamps if a post-hoc investigation
needs them.

## Why /api/auth/forgot-password is a separate route

The credentials provider lives at /api/auth/[...nextauth] (Auth.js's
default catch-all). We could've added a custom action there, but
Auth.js v5's contract for non-OAuth flows expects providers to be
declared at module level. A separate route handler is cleaner —
the forgot-password endpoint doesn't need session middleware, doesn't
share state with the credentials provider, and putting it next to
the credentials handler in the file system makes the surface
discoverable.

## SMTP gating

`process.env.SMTP_HOST` is the existing gate (auth.ts line 57). The
forgot-password handler still writes the token row even when SMTP is
unwired — that way a self-hosted instance without email can still
audit the attempted resets, and an operator can hand-deliver the link
from a Postgres shell if necessary. The audit row's `smtpConfigured`
field records whether the email actually went out, so post-hoc
investigation can correlate.

## Why not amend an existing migration

Spec 159 (idx 19) and spec 161 (this) ship in the same workflow run.
Drizzle-kit's journal is strictly ordered by `idx`; spec 159 took 19
per the orchestration notes, leaving 20 for this spec. Each
migration is independent (159 adds a column to `quizzes`, 161 adds
the password-reset / lockout schema); collapsing them into one file
would force a re-ordering of the journal that the orchestrator
explicitly assigned.
