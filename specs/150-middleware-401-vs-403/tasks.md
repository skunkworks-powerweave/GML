# Tasks 150

- [x] T1 → write the governance test (red) covering:
  - all five spec-kit files exist under
    `specs/150-middleware-401-vs-403/`;
  - `plan.md` follows the CREATED/EDITED/MIGRATED contract and
    names `middleware.ts` in the EDITED line;
  - `middleware.ts` carries an inline `Spec 150` marker so a
    future contributor reading the file knows to consult the spec
    before reverting the split;
  - the file declares TWO separate `if` branches inside the
    `auth((req) => { ... })` body — one on `!session?.user` (the
    401-equivalent path) and one on
    `policy.roles && !hasAnyRole(...)` (the 403 path);
  - the no-session branch sets BOTH `from` and `next` query
    params on the `/login` redirect URL, and the encoded `from`
    value includes the original search string;
  - the no-session branch calls `NextResponse.redirect(...)` (not
    `rewrite`);
  - the insufficient-role branch calls
    `NextResponse.rewrite(url, { status: 403 })` with the
    explicit status object — NOT the legacy
    `NextResponse.rewrite(url)` shape;
  - the session-check branch appears BEFORE the role-check
    branch in source order (the ordering invariant — pinned via
    `src.indexOf("!session?.user") < src.indexOf("hasAnyRole")`);
  - the route matcher config is unchanged (spec 150 doesn't
    touch the matched paths).
  Run suite → red.

- [x] T2 → edit `apps/web/src/middleware.ts`:
  - prepend the Spec-150 paragraph to the file header below the
    existing SM-1 reminder;
  - update the no-session branch to set both `from` (with
    `pathname + search`) and `next` (legacy alias) on the redirect
    URL;
  - change the insufficient-role branch's
    `NextResponse.rewrite(url)` to
    `NextResponse.rewrite(url, { status: 403 })`;
  - add inline comments on both branches referencing Spec 150.
  Run scoped governance test → green.

- [x] T3 → author all five spec-kit files under
  `specs/150-middleware-401-vs-403/` (spec.md, plan.md,
  research.md, quickstart.md, tasks.md).

- [x] T4 → run the full governance suite. Confirm no regression —
  the only behavioural change is the explicit `status: 403` and
  the additional `from` query param, neither of which any pre-
  existing test reads.

- [ ] T5 (future, out of scope) → wire the login page (`apps/web/src/app/login/page.tsx`
  + `DesktopLogin.tsx` / `MobileLogin.tsx`) to read `?from=` and
  bounce to that path on successful authentication. Currently the
  login page hard-codes `callbackUrl: "/dashboard"` in
  `email-link-form.tsx`; the spec-150 redirect emits the correct
  shape but the consumer ignores it. Out of scope here because the
  audit finding is specifically about the middleware shape, not
  the consumer; the next workflow run can pick this up.

- [ ] T6 (future, out of scope) → consider a similar `{ status:
  401 }` override on the `NextResponse.redirect` for the no-session
  branch. Currently the redirect returns 307 (Next 15 default),
  which is semantically close to "your request was rejected, try
  this other URL" but not literally 401. RFC-pedantic correctness
  would set the status to 401 and the `Location` header to /login,
  but most browsers don't follow 401 with a Location header
  (treating it as an auth-required body). The 307+from pattern is
  the pragmatic shape for browser-page redirects; revisit if a
  Next 16 changes the redirect default.

- [ ] T7 (future, out of scope) → audit the gate-cookie redirect
  (line 116 in the current file) for the same 401/403 split. That
  redirect only fires AFTER session AND role checks pass, so the
  split is already correct by construction (the user IS
  authenticated and AUTHORISED at that point — the missing gate
  cookie is a different shape of "you haven't unlocked this
  section yet"). The redirect to `/gate/<slug>` is the right
  response for that case; no change needed.
