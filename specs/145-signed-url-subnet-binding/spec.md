# Spec 145 — Signed-URL subnet binding (Workflow Run 13 audit closure)

## Why

The signed-URL helper at `apps/web/src/lib/video/signed-url.ts` binds
each token to the requesting client IP at exact /32 granularity. The
7-agent code audit (Workflow Run 13) flagged this as a HIGH-severity
UX defect: the LMS is operated primarily in Ladakh, where the user
network is overwhelmingly cellular (Reliance Jio + Airtel), and
cellular devices roam between towers continually. A learner
mid-playback who hands off from one tower to another gets a fresh
NAT mapping — the public IP changes — and the next HLS segment
request through `/api/media/[token]` is rejected with
`{ reason: "ip_mismatch" }`. The HlsPlayer surface presents this as
the video stopping cold, which mentors and learners report as
"the video keeps breaking after a minute".

Spec 145 moves the binding from /32 to /24 (IPv4) and /64 (IPv6).
The /24 boundary is the standard customer-end-site allocation for
nearly every consumer ISP and most cellular carriers — a tower
handoff that changes the host octet inside the same carrier prefix
still validates. The /64 boundary is the IETF-recommended end-site
boundary in IPv6. A cross-ISP hop (rare during a 5-minute token TTL
— would mean physically switching between Wi-Fi and cellular and
then between two different cellular ISPs in the same 5 minutes)
still rejects, which preserves the original threat model: tokens
are bound to a network identity, just at a coarser granularity.

## What we ship

### 1. `apps/web/src/lib/video/signed-url.ts` (EDITED)

- Exports a new helper `ipToBindKey(ip: string): string` that returns
  the /24 prefix for IPv4 (first three dotted octets) and the /64
  prefix for IPv6 (first four colon-separated hextets after
  expanding the `::` shorthand). The `"unknown"` sentinel value
  (used by the proxy route when no proxy header is present) round-
  trips unchanged so legacy callers keep working.
- `signMediaToken` collapses the supplied `ip` to its bind key via
  `ipToBindKey` and HMACs the bind key into the payload instead of
  the raw IP.
- `verifySignedToken` collapses the current request's IP to its
  bind key the same way and compares the prefix in constant time
  using the existing `timingSafeEqual` helper.
- The verifier's `:` parsing is generalised to handle IPv6 bind
  keys (which themselves contain colons). The fixed slots are
  bucket, objectKey, userId, and exp; everything between userId
  and exp is the bind key.
- File header comment documents the trade-off explicitly:
  /24 vs /32 trades exact-identity for stability under cellular
  roaming; a subnet-hop (rare) still rejects.

### 2. `apps/web/src/app/api/media/[token]/route.ts` (EDITED)

- Imports `ipToBindKey` alongside `verifySignedToken`.
- Passes `ipToBindKey(ip)` to `verifySignedToken` instead of the
  raw `ip`. The verifier ipToBindKey's its argument internally
  too, so this is belt-and-braces — but the explicit call at the
  callsite is the documented contract the spec ships.
- A `// Spec 145` comment block above the call explains the
  /24-vs-/32 trade-off in the proxy route itself, so an operator
  reading the request handler doesn't have to chase through the
  helper to understand why a subnet hop rejects.

### 3. `tests/governance/test_145_signed_url_subnet_binding.test.mjs` (CREATED)

Six+ assertions:

- `ipToBindKey` is exported from the helper module.
- `ipToBindKey("203.0.113.42")` returns `"203.0.113"` (drops the
  host octet of an IPv4 address).
- `ipToBindKey("2001:db8:1::abcd")` returns `"2001:db8:1:0"`
  (expands `::` and keeps the first four hextets).
- `signMediaToken` + `verifySignedToken` round-trips OK when the
  signer sees `203.0.113.42` and the verifier sees `203.0.113.99`
  (host octet changes — simulates a tower handoff inside the same
  /24).
- The round-trip FAILS with `reason: "ip_mismatch"` when the
  verifier sees `203.0.114.99` (the `/24` actually changed —
  cross-subnet hop).
- The verifier uses `timingSafeEqual` for the bind-key compare
  (constant-time, no early-return on first byte difference — same
  posture the signature compare already uses).
- The media proxy route imports `ipToBindKey` AND passes
  `ipToBindKey(ip)` to `verifySignedToken` (the explicit-callsite
  contract).
- All five spec-kit files exist.

## Acceptance criteria

- `apps/web/src/lib/video/signed-url.ts` exports `ipToBindKey` and
  uses it in both `signMediaToken` and `verifySignedToken`.
- `apps/web/src/app/api/media/[token]/route.ts` imports
  `ipToBindKey` and passes `ipToBindKey(ip)` to
  `verifySignedToken`.
- Existing phase-5 tests
  (`tests/governance/test_phase5_video.test.mjs` — already asserts
  `signMediaToken`, `verifySignedToken`, `ip_mismatch`, `createHmac`)
  still pass without change. The reason code stays
  `"ip_mismatch"`; only the granularity of the comparison shifts.
- All six+ assertions in
  `tests/governance/test_145_signed_url_subnet_binding.test.mjs`
  pass.
- All five spec-kit files exist under
  `specs/145-signed-url-subnet-binding/`.
- Full governance suite stays green (no regression).

## Non-goals

- **No schema change.** The bind key lives entirely inside the
  signed token payload; the database doesn't store it.
- **No new dependencies.** Pure string manipulation; `ipToBindKey`
  is ~20 lines of node-stdlib-only code.
- **No /16 or /32 toggle.** A future spec could expose the
  prefix length as an admin setting; for now /24 + /64 is hard-
  coded as the documented trade-off.
- **No revocation list.** A signed token is still self-contained
  and short-lived (5 min). The threat model is "stolen token
  replayed from a different network" and the /24 still rejects
  that for cross-ISP attackers — the policy-level enforcement is
  unchanged.
- **No IPv6-mapped-IPv4 normalisation.** `::ffff:203.0.113.42`-
  style addresses would be treated as IPv6 and bind to a /64; if
  this becomes an operational issue (it shouldn't — the proxy
  layer almost always presents the IPv4 form directly), a follow-
  up spec can normalise.
