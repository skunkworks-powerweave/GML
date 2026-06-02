# Tasks 145

- [x] T1 → write the governance test (red) covering: `ipToBindKey`
  export; IPv4 /24 collapse (`203.0.113.42` → `203.0.113`); IPv6
  /64 collapse including `::` expansion
  (`2001:db8:1::abcd` → `2001:db8:1:0`); intra-/24 round-trip
  success; cross-/24 round-trip rejection with `ip_mismatch`;
  bind-key compare via `timingSafeEqual` (constant-time, not
  `!==`); media proxy route imports `ipToBindKey` AND passes
  `ipToBindKey(ip)` to `verifySignedToken`; all five spec-kit
  files exist. Run suite → red.
- [x] T2 → edit `apps/web/src/lib/video/signed-url.ts`: add
  `ipToBindKey` helper (IPv4 `.split(".").slice(0,3).join(".")`
  for the /24 case, IPv6 `::` expansion + first-four-hextet slice
  for the /64 case, `"unknown"` and other non-IP strings pass
  through unchanged), replace the raw-IP fields in the
  sign/verify payload with the bind-key form, generalise the
  verifier's split parse to handle IPv6 bind keys (which contain
  colons themselves) by anchoring on fixed slots (bucket,
  objectKey, userId, expEpoch) and treating the in-between as
  the bind key, swap `!==` for `timingSafeEqual` on the bind-key
  compare, update file header comment to document the /24-vs-/32
  trade-off.
- [x] T3 → edit `apps/web/src/app/api/media/[token]/route.ts`:
  add `ipToBindKey` to the named imports next to
  `verifySignedToken`, change the `verifySignedToken(token, ip)`
  call to `verifySignedToken(token, ipToBindKey(ip))`, add a
  `// Spec 145` block comment at the callsite that names the
  cellular-handoff motivation explicitly.
- [x] T4 → author all five spec-kit files under
  `specs/145-signed-url-subnet-binding/`.
- [x] T5 → run the scoped governance suite
  (`pnpm test -- --test-name-pattern "spec 145"`) → green. Run
  the full suite to confirm no regression — the existing phase-5
  test asserts `signMediaToken`, `verifySignedToken`,
  `ip_mismatch`, `createHmac` and continues to pass because the
  reason code is unchanged and the function signatures are
  unchanged.
- [ ] T6 (future) → expose the prefix length as an admin setting
  for stationary-Wi-Fi deployments (urban LMS installs where /28
  or /32 is fine). Out of scope here — the deployment plan
  targets Ladakh first and /24 is the right default.
- [ ] T7 (future) → IPv4-mapped IPv6 (`::ffff:203.0.113.42`)
  normalisation so the bind key collapses to the IPv4 /24 even
  when the proxy presents it in v6 form. Out of scope — Caddy
  in front of the LMS always presents the v4 form directly. If
  this changes, follow up.
- [ ] T8 (future) → instrument an audit log for `ip_mismatch`
  rejections so operators can spot tokens being replayed across
  /24 boundaries. The signal would belong in spec 099-class
  audit-API work, not here. Out of scope for the UX fix.
