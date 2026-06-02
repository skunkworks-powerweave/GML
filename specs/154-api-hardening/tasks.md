# Tasks 154

- [x] T1 → write the governance test (red) covering all four issues:
  - `uploads/tus/route.ts` imports `auth` and every method handler
    early-returns 401 on missing session;
  - the 501 response body contains neither `TUSD_INTERNAL_URL` nor
    the string `hint`;
  - `form-drafts/[id]/route.ts` no longer contains
    `req.json().catch(() => ({}))` and instead returns
    `invalid_json` with a `message` field;
  - `helpdesk/tickets/route.ts` imports `rateLimit` from
    `@/lib/rate-limit` and calls it with bucket `"helpdesk"`, id
    `userId`, limit `5`, windowMs `60 * 60 * 1000`;
  - the throttle-hit branch returns 429 with a `Retry-After`
    header and audits `helpdesk.ticket_rate_limited`.
  Run suite → red.
- [x] T2 → edit `apps/web/src/app/api/uploads/tus/route.ts`:
  import `auth` from `@/auth`; add `requireAuth()` and
  `tusdUnavailable()` helpers; gate every method handler on the
  helper; add GET and DELETE handlers; collapse the 501 body to
  `{ error: "tusd_unavailable" }` and move the diagnostic to a
  `console.warn`. Run scoped governance test → auth-gate
  assertions green.
- [x] T3 → edit `apps/web/src/app/api/form-drafts/[id]/route.ts`:
  replace the `.catch(() => ({}))` swallow on the PUT handler with
  an explicit try/catch that returns 400 `{ error: "invalid_json",
  message: String(err) }`. Schema-validation 400 path is
  unchanged. Run scoped governance test → invalid-json assertion
  green.
- [x] T4 → edit `apps/web/src/app/api/helpdesk/tickets/route.ts`:
  import `rateLimit` from `@/lib/rate-limit`; declare the two
  threshold constants; insert the try/catch rate-limit block
  immediately after the auth gate; on `!rl.ok` audit
  `helpdesk.ticket_rate_limited` and return 429 with
  `Retry-After`; on Redis fault log and fall through. Run scoped
  governance test → rate-limit assertions green.
- [x] T5 → author all five spec-kit files under
  `specs/154-api-hardening/`.
- [x] T6 → run the full governance suite. Confirm no regression —
  the route-handler edits are additive (auth gate, rate limit)
  and the JSON-parse rewrite preserves the existing 400 response
  code so no test that asserts on status codes regresses.
- [ ] T7 (future, out of scope) → unify the `requireAuth()` helper
  across every API route. Today multiple routes inline `auth()`
  with slightly different early-return shapes; a single shared
  helper would reduce the surface for the next audit pass.
- [ ] T8 (future, out of scope) → consider applying the same
  rate-limit pattern to `/api/form-drafts/[id]` and
  `/api/contact` (other endpoints with no explicit throttle). The
  threat model for those is lower than helpdesk (no admin
  inbox-floods) so this isn't urgent but worth a follow-up audit.
- [ ] T9 (future, out of scope) → emit a metric (Prometheus
  counter) on every rate-limit hit so SRE can alert on abuse
  patterns before they reach the audit log. Today the audit row
  is the only signal and it's polled, not pushed.
- [ ] T10 (future, out of scope) → add a Playwright integration
  test that exercises the tus proxy end-to-end with a real
  tusd container — currently the governance test pins the auth
  contract via regex; an integration test would also verify the
  401-passthrough on a misconfigured proxy chain.
