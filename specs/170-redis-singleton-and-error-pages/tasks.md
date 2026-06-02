# Tasks 170

- [x] T1 → author the governance test (red) covering the singleton
  module shape, the rate-limit + health refactor pinning, the
  forbidden-page four-variant rendering, the auth.ts
  AccountLockedError shape, and the loginAction redirect target.
- [x] T2 → create `apps/web/src/lib/redis.ts` exporting `getRedis()`
  and `pingRedis()`. Defaults match the worker's queues.ts shape.
  Inline header comment explains scope: direct redis calls only,
  BullMQ stays on its own connection.
- [x] T3 → edit `apps/web/src/lib/rate-limit.ts`: remove the local
  `client()` factory and `_client` cache; the `rateLimit()`
  function calls `getRedis()` from `./redis` instead. Update the
  JSDoc FAIL-CLOSED block to reference the singleton.
- [x] T4 → edit `apps/web/src/lib/health.ts`: rewrite `pingRedis()`
  to delegate to `./redis`'s `pingRedis`. The per-probe `new Redis`
  + `client.connect()` + `client.quit()` shape is removed.
- [x] T5 → edit `apps/web/src/app/forbidden/page.tsx` into a Server
  Component that reads `searchParams.reason` and renders one of the
  four copy variants. The locked branch calls `auth()` to read
  `session.user.locked_until` and formats the time-remaining hint
  with a 1-hour fallback. Adds `data-testid="forbidden-page"` and
  `data-reason={reason}` for governance / e2e pinning.
- [x] T6 → edit `apps/web/src/auth.ts`: declare and export
  `class AccountLockedError extends CredentialsSignin` with
  `code = "account_locked"`. Change the locked-account branch in
  `authorize()` to `throw new AccountLockedError()`. Preserve the
  spec 161 audit row firing BEFORE the throw.
- [x] T7 → edit `apps/web/src/app/login/actions.ts`: catch
  AuthError, detect `code === "account_locked"`, and
  `redirect("/forbidden?reason=locked")`. Other AuthError causes
  fall through to the existing generic error message.
- [x] T8 → author all five spec-kit files under
  `specs/170-redis-singleton-and-error-pages/`.
- [x] T9 → run the full governance suite. Confirm 1423/1423 still
  passes plus the new spec 170 assertions. The singleton refactor
  is behaviour-preserving; the lockout error-class change preserves
  every assertion pinned by spec 161's governance test (the audit
  row, the `>= 5` threshold, the `60 * 60 * 1000` window, the
  `lastSeenAt + failedLoginCount=0 + lockedUntil=null` reset).
- [ ] T10 (future, out of scope) → middleware-side reason passing.
  Currently the middleware role-gate rewrite to `/forbidden` passes
  no reason, so the user sees the default copy. A future spec
  could add `reason=tenant_suspended` or `reason=schedule_window`
  branches when those cases land. The page-side switch is shipped
  ready for those additions.
- [ ] T11 (future, out of scope) → port the singleton to the worker
  too. The worker has its own BullMQ-private connection in
  `apps/worker/src/queues.ts`. A future spec could expose a
  separate worker-side `getRedis()` for non-BullMQ direct calls
  (e.g. distributed locks, presence keys). Currently the worker
  has no such call sites so the singleton would be unused.
- [ ] T12 (future, out of scope) → i18n the four forbidden variants.
  The strings are English-only today; spec 155's LanguagePicker is
  the path for translation. Bringing the locked-time-remaining
  hint through the existing i18n pipeline (with proper
  pluralisation rules for `hi-IN` and `bo-IN`) is a follow-up.
