# Quickstart 150 — Middleware 401-vs-403 split

Three manual smokes, each ~2 minutes. All require a clean session
(logout first via `/logout` or clear the `authjs.session-token`
cookie).

## (A) Unauthenticated → /login with `from=` param

1. Boot `pnpm dev` + docker-compose db / redis / minio.
2. With NO cookie / fresh browser tab, visit `/admin/users`.
3. The address bar should switch to
   `/login?from=%2Fadmin%2Fusers&next=%2Fadmin%2Fusers`. (The
   percent-encoded `from` is canonical per spec 150; the `next=`
   alias is preserved for backward compatibility.)
4. DevTools Network panel should show:
   - GET `/admin/users` → 307 (NextResponse.redirect default).
   - GET `/login?from=...` → 200.
5. Visit `/admin/users?q=foo&page=3`. The redirect should preserve
   the full query: `?from=%2Fadmin%2Fusers%3Fq%3Dfoo%26page%3D3`.

## (B) Authenticated-but-insufficient-role → /forbidden with 403

6. Log in as a `teacher` (any seeded teacher account from spec 084).
7. Visit `/admin/users` (programme_admin or higher required per the
   POLICIES table).
8. The address bar stays on `/admin/users` (rewrite, not redirect).
9. The body renders the `/forbidden` page ("403 Forbidden — Your role
   does not permit access...").
10. DevTools Network panel should now show:
    - GET `/admin/users` → **403** (not 200 — this is the spec-150 fix).
11. From a terminal, verify with curl:
    ```sh
    curl -i -b "$(cat session-cookie)" http://localhost:3000/admin/users
    ```
    First line of output: `HTTP/1.1 403 Forbidden`. Pre-spec-150 it
    would have been `HTTP/1.1 200 OK` (rewrite default).

## (C) Ordering invariant — unauth visit to role-gated route does NOT 403

12. Log out (clear the session cookie).
13. Visit `/admin/users` again.
14. Confirm the response is still the 307 redirect from step (A), NOT
    the 403 rewrite from step (B). The session-presence check fires
    BEFORE the role check, so unauthenticated visits to `/admin/*`
    bounce to login rather than landing on `/forbidden` with a
    confusing "your role lacks permission" message (the user has no
    role at all — they need to log in first).

## Authenticated regression check

15. Log in as a `programme_admin`. Visit `/admin/users`. The page
    renders normally (200, full admin table). Neither the 302 from
    (A) nor the 403 from (B) fires — the middleware passes through
    to `NextResponse.next()`.
16. While still logged in as `programme_admin`, visit `/dashboard` —
    a `loggedIn: true` policy (no `roles` array). The middleware
    sees session present, no role check needed, passes through.

## Test gate

17. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 150"
    ```
    All assertions green. Full suite still passes (1197 / 1197
    pre-spec; this spec adds new tests but does not regress
    existing ones — the only behavioural change is the explicit
    `status: 403` on the rewrite, which `test_007_rbac_middleware`
    doesn't assert on).
