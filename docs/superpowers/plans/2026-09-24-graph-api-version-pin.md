# Plan — the WhatsApp webhook calls an expired Graph API version

**Branch:** `fix/graph-api-version` · **Worktree:** `.worktrees/graph-api-version`
**Base:** `chore/enforcement` (see *Why this branches off an unmerged branch* below)

## Goal

`apps/web/src/app/api/webhooks/whatsapp/route.ts` fetched media metadata from a
URL with the Graph API version written into it:

```ts
const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(mediaId)}`, {
```

Meta's published table gives v19.0 an expiration of **2026-05-21** — four months
before today. That is the code the webhook would run. Whether any deployment has
actually made the call is **not established**: `docs/verification.md` records
that the ingest path has never been exercised with a real Meta delivery.

Make the version a single named constant, overridable by environment, and make
the next expiry impossible to miss.

## Why it was invisible

It never failed, so nothing recorded it. Meta's versioning guide, read at the
source (https://developers.facebook.com/docs/graph-api/guides/versioning):

> "once a version is no longer usable, any calls made to it will be defaulted to
> the next oldest, usable version."

So a call to v19.0 is served by v20.0 until that expires today (2026-09-24), then
by v21.0 — the API underneath the code changes at each expiry, silently. **No
media is lost to this.** The risk is semantic drift that nobody scheduled and
nobody would see.

That is why the fix is a *test that fails on a date* rather than a bumped string:
a defect that never produces an error can only be caught by a clock.

**Correction.** The first version of this section said "three silences compose"
and that an expired version, a blank token and a revoked token were "all
externally indistinguishable from the teacher never sent a video". The first half
of that was right and the rest was not: `route.ts` records
`whatsapp.media.url_failed` when `fetchMediaUrl` returns null (line 159) and
`whatsapp.media.fetch_failed` when `downloadMediaBytes` does (line 166). A blank
or revoked token leaves an audit row. The expired version was the only case that
left none — because it was the only one that did not fail.

## Architecture

| Decision | Why |
|---|---|
| Constant lives in `packages/shared/src/whatsapp/graph.ts` | `route.ts` imports `@gml/db`, `next/server` and `@/lib/*`, so it cannot be imported by a test. A pure module in `shared` can be, which is what makes the URL testable at all. |
| Pin the newest version with a **published** expiry (`v25.0`, expires 2028-07-29) | Not the newest outright. `v26.0` has expiry "TBD", and pinning it would silently disarm the expiry canary — the one check that exists to stop this recurring. v25.0 still leaves 22 months. |
| `WHATSAPP_GRAPH_API_VERSION` overrides it | An expiry should be survivable by setting a variable and restarting, not by shipping code. That is exactly the situation this defect created. |
| A malformed override is **refused**, not passed through | `v25` would go straight into the URL path, Meta would reject it, and `!r.ok` would drop the video. The audit log records it as `whatsapp.media.url_failed` — but nothing in that row names the variable that caused it, so it reads as a Meta outage. (A trailing newline is trimmed first.) The check is of *shape* not *membership*: `v19.0` passes it, so an operator can recreate the original defect through the override, and the canary will not see it because it reads the pin from source. |
| `phone_number_id` scoping **not** wired up | Meta accepts it as an optional scoping parameter on this endpoint, which would give `WHATSAPP_PHONE_NUMBER_ID` (read by nothing today) a real use. It is a behaviour change to the fetch and belongs in its own commit with its own test. Recorded below. |

## Steps

1. **RED** — `tests/governance/test_173_graph_api_version_pin.test.mjs`: no
   version literal in a URL; exactly one Graph call site; the pin is a version
   Meta publishes; the pin has not expired (90-day grace); the override exists
   and is documented and plumbed. Six assertions, all failing.
2. **GREEN** — add the shared module; point `route.ts` at it; add the export map
   entry; document in `.env.example`; forward in `docker-compose.yml`.
3. **Behaviour** — `tests/behaviour/whatsapp-graph.test.ts` executes the builder:
   the URL carries the pin, the override works, blank/whitespace falls back, a
   malformed override is refused *and says so*, and the media id is
   percent-encoded.
4. **Mutation** — five mutations, each required to redden only its own tests.

## Evidence

Per `docs/superpowers/README.md`, TS product code needs a behaviour test that
fails on the pre-change code. Both tiers are used here because they catch
different things:

- the **governance** file catches the pin going stale *on a date* — the actual
  defect — and cannot observe a URL;
- the **behaviour** file catches the builder being wrong and cannot observe a
  date.

## Why this branches off an unmerged branch

`chore/enforcement` (PR #2) carries `scripts/test-gate.mjs`, the hooks, the PR
template and this contract. `main` has none of them, so a branch from `main`
could not produce a receipt or follow the discipline this task asks for. The
cost is that this PR stacks: it targets `chore/enforcement` and lands after it.

The product files it touches are byte-identical on both branches, so it rebases
onto `main` cleanly if PR #2 is abandoned.

## Follow-ups, not done here

- **`phone_number_id` scoping** on the media fetch (above). Meta: "the request
  will only be processed if the business phone number ID included in the query
  matches the ID of the business phone number that the media was uploaded on."
- **Fetch failures are audited but not diagnosable.** Every failure in
  `fetchMediaUrl` / `downloadMediaBytes` returns `null` and the webhook still
  answers 200 — but the fetch failures ARE audited, as `whatsapp.media.url_failed`
  (`route.ts:159`) and `whatsapp.media.fetch_failed` (`route.ts:166`). What those
  rows lack is the cause: an HTTP status, a Graph error code, whether the token
  was blank. An earlier version of this bullet said "nothing is logged and
  nothing is audited on a failed fetch", which was false.
- **`WHATSAPP_ACCESS_TOKEN` is soft-defaulted** in `docker-compose.yml`, so a
  deployment with it blank boots clean and drops every video.
