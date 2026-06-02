# Research 145

Five design decisions captured inline in the spec, plus the
trade-off justification the audit asked us to document.

## (1) Why /24 (IPv4) and /64 (IPv6) specifically

The two prefix lengths are the conventional end-site boundaries:

- **/24 for IPv4** is the standard customer allocation unit at the
  consumer-ISP layer for nearly every Indian mobile operator
  (Reliance Jio, Bharti Airtel, Vi). A learner whose phone roams
  between cell towers inside the same operator's footprint
  reliably stays inside a /24 — the host octet flips, the
  remaining 24 bits stay constant. We confirmed this against
  Reliance Jio's publicly-published BGP advertisements via
  team-cymru's whois (`/24` aggregations dominate the table). A
  /24 also matches the operational instinct of every network
  engineer who'll ever debug a "video stops mid-playback" support
  ticket — they're already reading IPs at /24 granularity in
  logs.
- **/64 for IPv6** is the IETF-recommended end-site allocation
  boundary in RFC 6177. Every consumer ISP that hands out IPv6
  prefixes hands out at least a /64 to the end-user — a phone
  that switches Wi-Fi-to-cellular within the same end-site (e.g.
  rural learner's home → field trip in the same town) stays
  inside the same /64. A /48 would be too coarse (entire
  customer site instead of a single device); a /56 or /60 would
  be too narrow (some carriers fragment below /56). /64 is the
  Goldilocks zone.

A future spec could expose the prefix length as an admin setting
(e.g. urban deployments where the IP layer is stabler could opt
for /28); we explicitly leave that out of scope because the
JSX prototype and the deployment plan both target Ladakh first.

## (2) Trade-off: exact identity → carrier-grade-NAT stability

The original /32 binding pinned a token to a single client IP for
its entire 5-minute lifetime. The threat model was:

> A stolen token replayed from a different client should fail.

That threat model holds at /32 only for stationary-Wi-Fi clients.
Cellular clients fail the original model on legitimate use —
the IP changes mid-session without the client doing anything
wrong. The /24 widening trades:

- **Lost** — an attacker on the same /24 as the original signer
  (i.e. another customer of the same cell tower) could replay
  the token within the 5-minute window. Practically: the
  attacker would need (a) the leaked token, (b) physical proximity
  to the same cell tower, AND (c) the attack window before the
  token expires. The probability and impact are both low (the
  attacker only gains 5 minutes of access to a single video
  segment, no escalation path).
- **Gained** — the 99%-case of cellular learners playing through
  a 5-minute video without interruption works. Operationally
  this is the single largest UX complaint the audit surfaced.
- **Preserved** — a cross-/24 hop (different carrier, different
  geography, different ISP entirely) still rejects with
  `ip_mismatch`. The policy-level enforcement against stolen-
  token-cross-region replay is intact.

We considered three alternatives and rejected each:

1. **Drop IP binding entirely** — would make tokens fully
   bearer-token-like; any leaked URL works from anywhere for 5
   minutes. Too coarse a relaxation.
2. **Re-issue tokens on IP change** — requires the client to detect
   the change and re-fetch the master playlist, which conflicts
   with hls.js's caching behaviour and would still drop one
   segment during the renegotiation.
3. **Extend TTL to compensate** — does nothing for the actual
   IP-change-mid-session problem; the very next segment after the
   handoff still 401s.

## (3) IPv6 expansion before slicing

`ipToBindKey` expands the `::` shorthand to a full 8-hextet form
before slicing the first four hextets. We do this because both
the signer AND the verifier run the same function, so consistent
representation is what matters — but the expansion is robust:

- `2001:db8::1` → `2001:db8:0:0:0:0:0:1` → bind key
  `2001:db8:0:0`.
- `::1` (loopback) → `0:0:0:0:0:0:0:1` → bind key `0:0:0:0`.
- `fe80::1%eth0` (link-local with zone) → zone stripped →
  `fe80::1` → expanded → `fe80:0:0:0:0:0:0:1` → bind key
  `fe80:0:0:0`.

We don't do leading-zero dropping (e.g. `2001:0db8` → `2001:db8`)
or `0:0:` → `::` re-compression on the OUTPUT side. We don't
need to: the comparison is byte-exact between two outputs of the
same function. The trade-off is that a malicious or buggy proxy
that hands us non-canonical IPv6 forms could in theory produce a
different bind key — but the proxy in front of the LMS is Caddy,
which always emits canonical lowercase-hex form, so the risk is
not realised in practice.

## (4) Why generalise the verifier's split parsing

The original verifier did `decoded.split(":")` and asserted
exactly 5 fields. With IPv6 bind keys, the bind key itself
contains colons (`2001:db8:1:0` is three colons inside the bind
key value), so the field count varies.

The fix anchors on FIXED slots:

- `fields[0]` — bucket (no colons in bucket names by S3 spec).
- `fields[1]` — objectKey (we'd have to escape colons in keys
  for the original verifier to work too; in practice our keys
  are UUID-based and don't contain colons).
- `fields[2]` — userId (UUID — no colons).
- `fields[fields.length - 1]` — expEpoch (integer string — no
  colons).
- `fields.slice(3, -1).join(":")` — bind key (could be one
  field for IPv4, four fields for IPv6).

This is a strict superset of the original behaviour: a 5-field
payload (IPv4 case) still parses identically.

## (5) timingSafeEqual on the bind-key compare

The original verifier compared the raw IP with `!==`, which has
two issues:

1. JS string `!==` is not constant-time.
2. After the /24 collapse, the comparison values are
   attacker-controlled in part (the attacker chooses their own
   IP). A constant-time compare denies them any timing oracle.

The fix uses the same `timingSafeEqual` helper the signature
compare already uses. The helper is a 5-line `XOR-OR-accumulate`
that works on equal-length strings; we don't need
node's `crypto.timingSafeEqual` because we already have an
equivalent helper in scope and adding a Buffer round-trip would
be wasted work.

## (6) "unknown" sentinel passthrough

The proxy route falls back to the literal string `"unknown"` when
neither `x-forwarded-for` nor `x-real-ip` is present (e.g. when
the LMS is bench-tested with `pnpm dev` directly without Caddy
in front of it). `ipToBindKey("unknown")` returns `"unknown"`
unchanged, so the sign + verify round-trip still works in
development — and the resulting token is bound to the
operational reality "I have no idea what your IP is, but the
sign and verify sides agree they don't know", which is the
correct degenerate behaviour.

## Why this is a HIGH severity audit finding (and not CRITICAL)

CRITICAL findings break a security invariant or corrupt data.
This finding breaks a UX invariant — "the video keeps playing
once it starts". It doesn't grant unauthorised access (an
attacker still needs the leaked token, the right /24, and the
5-minute window). The harm is operational + reputational
(learners give up on video lessons because they're unreliable),
which is severe enough to warrant a hot-path fix but doesn't
gate the substrate.
