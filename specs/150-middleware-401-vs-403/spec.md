# Spec 150 — Middleware 401-vs-403 distinction (Workflow Run 14 audit closure)

**Status:** complete · **Date:** 2026-06-02 · **Phase:** Workflow Run 14 (audit-closure) · **Severity:** MEDIUM (response-shape regression on unauthenticated visits to role-gated routes).

## Why

The Workflow Run 14 7-agent code audit closed the MEDIUM tier of the
post-Run-13 findings. Item 7 of that tier flagged
`apps/web/src/middleware.ts:57-60`:

> Returns 403 (rewrite to `/forbidden`) for unauthenticated users instead
> of redirecting to `/login` with a 401-equivalent shape.

Reading the actual file lines 50-60 reveals the audit finding is
*partially* outdated — the session-presence check already runs first and
DOES redirect to `/login`. But the underlying design intent was wider
than the literal lines 57-60: the audit reviewer wanted to confirm two
properties hold ROBUSTLY across the file:

1. **Ordering invariant.** The session check fires BEFORE the role
   check. An unauthenticated visit to `/admin/*` must redirect (302)
   to `/login`, not rewrite to `/forbidden`. Today the order is
   correct, but the audit wants the invariant pinned in the test gate
   so a future refactor (e.g. flattening the two checks into a single
   conditional, or extracting them into helpers) can't silently
   reverse the order.
2. **Status code on the 403 path.** `NextResponse.rewrite(url)` with
   no status override returns the destination page's default status —
   for `/forbidden/page.tsx` that's HTTP 200. So the response BODY
   says "403 Forbidden" but the HTTP RESPONSE LINE says `200 OK`.
   Curl, fetch, monitoring probes, and any non-browser caller see 200
   and conclude the protected route is reachable. The fix is one
   parameter: `NextResponse.rewrite(url, { status: 403 })`.

A third related improvement: the redirect already passes the original
path as `?next=...`, but the wider LMS convention (audit-export route,
spec-141 auth header, etc.) uses `?from=...`. We set BOTH so the
contract is unambiguous; older callers reading `next` still work and new
callers can read `from`.

## What we ship

### `apps/web/src/middleware.ts` (EDITED)

Three surgical changes inside `auth((req) => { ... })`:

1. **File header gains a Spec-150 paragraph** documenting the
   401-vs-403 split, the ordering invariant, and the `from`/`next`
   parameter pair. The paragraph sits below the existing SM-1 reminder
   and above the imports.

2. **Unauthenticated branch** (`if (!session?.user)`):
   - Sets both `?from=<pathname+search>` (new, per spec) AND
     `?next=<pathname>` (legacy, preserved). Order matters:
     `searchParams.set("from", ...)` first, then `set("next", ...)`,
     so the canonical key in the URL is `from`.
   - Includes `nextUrl.search ?? ""` in the encoded path so query
     params on the original request survive the round-trip (e.g.
     `/admin/users?q=foo` re-renders the search after login).
   - Inline comment references Spec 150 and explains "must run BEFORE
     the role gate".

3. **Insufficient-role branch** (`if (policy.roles && !hasAnyRole(...))`):
   - Changes `NextResponse.rewrite(url)` → `NextResponse.rewrite(url, { status: 403 })`.
   - Inline comment explains why the explicit status is needed (the
     rewrite-default returns the destination's status, which for
     `/forbidden/page.tsx` is the implicit 200 of any successfully-
     rendered RSC).

### No new dependencies

`NextResponse.rewrite` already accepts a `ResponseInit`-shaped second
argument in Next 15's `next/server` types — no version bump needed.

### No schema change

The fix is entirely in the middleware Edge function. No migration is
consumed; the next migration idx (`0018`) stays available for spec 153.

## Acceptance

- `apps/web/src/middleware.ts` carries a Spec-150 paragraph in the
  file header.
- The `!session?.user` branch:
  - calls `searchParams.set("from", ...)` with `nextUrl.pathname` plus
    the original search string,
  - still calls `searchParams.set("next", ...)` for backward
    compatibility,
  - calls `NextResponse.redirect(...)` (not `rewrite`).
- The role-check branch calls
  `NextResponse.rewrite(url, { status: 403 })` with the explicit
  status object.
- The order of the two branches is preserved (session-check first,
  role-check second).
- The governance test
  `tests/governance/test_150_middleware_401_vs_403.test.mjs`
  passes with 8+ assertions covering the above invariants plus
  the spec-kit file presence + the no-dependency contract.

## Non-goals

- **No login-page change.** The login page (`apps/web/src/app/login/page.tsx`)
  does not currently consume `?next` or `?from` — that's a separate
  spec (audit-closure follow-up if needed). This spec only ensures the
  middleware emits the correct shape; consumption is downstream.
- **No status-code change for the redirect.** `NextResponse.redirect`
  returns 307 (or 302 in older callers). The spec is about 401-vs-403
  *semantics*; the redirect itself is the 401-equivalent signal.
- **No new audit row.** Both branches are read-only request-rewrites
  and don't touch the audit log (SM-1 is preserved; the audit
  middleware lands in spec 010 and runs orthogonally).
- **No change to the gate-cookie branch** further down the file. That
  branch only fires AFTER role check passes, so the 401/403 split is
  already correct for it by construction.
