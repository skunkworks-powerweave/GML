# Research 150

Four design choices behind the 401-vs-403 split.

## (1) Why redirect (302) and not return a literal 401 from middleware

A plain `NextResponse.json({ error: "Unauthorized" }, { status: 401 })`
would be the textbook semantic match — the route requires auth, the
user has none, return 401. But the user requesting `/admin/users` from
a browser tab does not want a JSON 401; they want to be sent to the
login screen. The HTTP convention for that is a 302/307 redirect to
`/login` with the original URL captured in a `from` query param. The
redirect IS the 401-equivalent signal — the browser sees the auth
challenge and follows it.

Modern API conventions (Next 15, RFC 9110) accept this. A pure-JSON
401 would be appropriate for `/api/*` routes where the caller is a
fetch / SDK and cares about the status code. The middleware matcher
explicitly excludes `/api/*`, so every match is a page request from a
browser — redirect is the right shape.

## (2) Why `from=` AND `next=` on the redirect URL

The wider LMS uses `from=` (audit export, spec 141 auth flows) as the
"where I was" parameter. But spec 007 originally shipped the middleware
with `next=`, and the gate redirect further down the file also uses
`next=`. Changing the parameter name unilaterally would:

- Break any external link or test fixture that reads `next` from the
  query string after a forced logout.
- Diverge from the gate redirect (line 115) which still emits `next=`.

The compromise: emit BOTH. `from=` is the canonical key per spec-150;
`next=` survives as a legacy alias. The login page (when it eventually
reads the param — currently it doesn't) can prefer `from` and fall
back to `next`.

Two assertions in the governance test pin both — a future refactor that
drops `next=` would still need to explicitly remove that test.

## (3) Why include `nextUrl.search` in the encoded `from` path

The original middleware encoded only `nextUrl.pathname`. So a visit to
`/admin/users?q=foo&page=3` got bounced to `/login?next=/admin/users`
— the user logs in, gets sent back to `/admin/users`, and the search /
pagination is lost. The fix is `nextUrl.pathname + (nextUrl.search ?? "")`
so the entire deep link survives.

`nextUrl.search` is `?q=foo&page=3` (with the leading `?`) if there's a
query, or `""` if there isn't. We coalesce with `?? ""` so the
concatenation works either way without an undefined-stringification
glitch.

`searchParams.set` URL-encodes the value automatically, so the `?` and
`&` in the encoded path are correctly percent-escaped in the
destination URL.

## (4) Why `{ status: 403 }` on rewrite and not redirect-to-/forbidden

Two viable shapes for the insufficient-role branch:

- **`NextResponse.rewrite("/forbidden", { status: 403 })`** — URL bar
  stays on the protected path, body renders the `/forbidden` page,
  status line says 403. The user sees `/admin/users` in their address
  bar with a 403 message in the page.
- **`NextResponse.redirect("/forbidden", { status: 303 })`** — URL bar
  changes to `/forbidden`, body renders the page with status 200, but
  the user loses the breadcrumb of which route they were denied.

We keep `rewrite` for the URL-bar-preservation reason: a programme
admin debugging a user's report ("I clicked the link they sent me and
got a 403") wants to see the exact URL the user was on, not have it
overwritten with `/forbidden`. The rewrite also avoids the second
round-trip a redirect would force.

The `{ status: 403 }` second argument is the operative fix here. Without
it, the rewrite returns the destination page's default status — which
for an RSC page is 200 unless the page itself sets `headers()` or
`notFound()`. The audit finding was that curl callers and monitoring
probes were seeing 200 OK with a "403 Forbidden" body, which is the
worst of both worlds (the body says one thing, the status line says
another). Setting the status on the rewrite response itself fixes both
the curl-observer and the body-renderer.

Reference: Next 15 `NextResponse.rewrite` signature accepts
`(url, init?: ResponseInit)`. The `init.status` field overrides the
destination's status. See `next/server` types or
https://nextjs.org/docs/app/api-reference/functions/next-response (the
LMS does not pin the version here; the signature has been stable since
Next 13).

## (5) Why pin both branches in the test (and not just the 403)

The audit finding called out only the 403-on-unauth case. But the test
gate's job is to lock the FULL contract, not just the audit-flagged
sub-case. A future refactor flattening:

```ts
if (!session?.user) { redirect; }
if (policy.roles && !hasAnyRole(...)) { rewrite; }
```

into:

```ts
const ok = session?.user && (!policy.roles || hasAnyRole(...));
if (!ok) {
  // single branch — what do we return?
}
```

would lose the 401-vs-403 distinction silently. The governance test
pins the TWO branches as separate `if` blocks, ordered session-first,
so the flattening above would fail multiple assertions and the
contributor would have to add an explicit re-discriminate inside the
collapsed branch to make them pass — which by then would be a strictly
worse refactor than the current shape.

This is the LMS test-gate pattern across all audit-closure specs:
encode the SHAPE that's hard to revert, not just the symptom that was
flagged.
