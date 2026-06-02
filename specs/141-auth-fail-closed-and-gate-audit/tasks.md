# Tasks 141

- [x] T1 → write the governance test (red) covering: recordAudit
  signature returns Promise<boolean>; auth.ts imports recordAudit
  and contains the maskIp helper; auth.ts Redis-down branch
  emits `auth.rate_limit.redis_down` with severity SEVERE and
  returns null; gate actions.ts imports recordAudit; gate
  actions.ts Redis-down branch emits
  `gate.rate_limit.redis_down` and returns the
  SERVICE_UNAVAILABLE string; verifyGate emits
  `gate.attempt.success` on the success path; verifyGate emits
  `gate.attempt.fail` on the wrong-password path with reason
  `wrong_password`; verifyGate emits `gate.attempt.fail` on the
  rate-limit-exceeded path with reason `rate_limit_exceeded`;
  no `metadata: { ... }` block in either file contains the
  token `password` or `plaintext`; docs/audit-actions.md lists
  both new actions; all five spec-kit files exist. Run suite →
  red.
- [x] T2 → edit `apps/web/src/lib/audit.ts`: change recordAudit
  return type to Promise<boolean>; return true on commit and
  false on caught failure; add optional `userId` + `ipOverride`
  inputs; wrap the `auth()` and `headers()` calls each in their
  own try/catch so a missing request scope downgrades to
  "insert without that field" rather than dropping the row.
- [x] T3 → edit `apps/web/src/auth.ts`: import recordAudit; add
  the private maskIp helper for IPv4 last-octet and IPv6
  last-hextet redaction; replace the silent fail-open catch on
  the rate-limit call with: emit SEVERE
  `auth.rate_limit.redis_down` audit row with metadata
  `{ method, ipMasked, severity, error: truncated }`, then
  `return null` (fail-closed); update the surrounding comment
  to document the fail-closed contract.
- [x] T4 → edit `apps/web/src/app/gate/[slug]/actions.ts`:
  import recordAudit; introduce the `SERVICE_UNAVAILABLE`
  constant; track `rateLimited` and `attemptCount` across the
  action body; emit `gate.attempt.success` on the success path
  (before the cookie + redirect so a redirect-induced exception
  doesn't suppress the row); emit `gate.attempt.fail` on the
  rate-limit-exceeded path with reason `rate_limit_exceeded`;
  emit `gate.attempt.fail` on the wrong-password path with
  reason `wrong_password`; emit SEVERE
  `gate.rate_limit.redis_down` on the Redis fault path and
  return `{ error: SERVICE_UNAVAILABLE }`.
- [x] T5 → edit `docs/audit-actions.md`: the `gate.*` row gains
  `gate.rate_limit.redis_down`; a new `auth.*` row documents
  `auth.rate_limit.redis_down`; both rows carry the spec 141
  cross-ref.
- [x] T6 → run the suite. Confirm green.
- [x] T7 → smoke per quickstart 141 (gate happy path; wrong
  password audit; rate-limit ceiling audit; Redis fail-closed
  on both auth and gate channels; /admin/gates dashboard
  reflects real attempts and failures).
