# Spec 163 — NITS cleanup (Workflow Run 15 audit closure, NIT round)

## Why

The 7-agent code audit at the close of Workflow Run 14 (after specs
148-156 landed) flagged five small-but-real maintenance NITS. None is
a bug, none is a behavioural delta — but each is a paper-cut that
makes the codebase harder to read for the next contributor:

1. **Worker `console.log` scatter.** `apps/worker/src/index.ts` had
   six call sites mixing `console.log`, `console.warn`, and
   `console.error`, with three different inline bracket tags
   (`[worker]`, `[retention]`, and a couple of bare lines). Log
   shippers (Loki / Promtail per `docs/operations.md`) had no
   consistent prefix to filter on; an operator triaging a worker
   issue had to grep for three different tags.

2. **Stale TODO in middleware.** Line 3 of
   `apps/web/src/middleware.ts` carried a comment reading
   "Substrate-moat reminder: changes here must not bypass SM-1 (audit
   log) once the auditing middleware lands in spec 010". Spec 010
   shipped in Phase 1 — the comment was a stale promise pointing at
   a non-existent gap. A reader auditing the file in 2026 would go
   looking for the missing middleware and waste cycles.

3. **`EN` hardcode in Topbar.** A previous audit (spec 155) wired
   the language picker to a real `LanguagePicker` client island
   reading from `user_prefs.uiLanguage`. The NIT round verified
   there is no remaining hardcoded "EN" label in the Topbar — but
   the verification itself is worth pinning so a future regression
   doesn't reintroduce a literal `<span>EN</span>` somewhere in the
   chrome.

4. **Brittle `pathToFileURL` guard in `retention.ts`.** The script
   entry-point guard at the bottom of
   `packages/db/src/scripts/retention.ts` compares
   `import.meta.url` to `pathToFileURL(process.argv[1])`. Under
   normal `tsx retention.ts` invocation this works fine. Under
   `pnpm` workspace symlinks (the same script reachable as
   `node_modules/.pnpm/@gml+db@.../scripts/retention.ts` AND as
   `packages/db/src/scripts/retention.ts`) the two paths resolve
   to different absolute strings even though they're the same
   file. The guard then returns false and the script silently
   no-ops when invoked directly. A basename-fallback closes the
   gap.

5. **Rate-limit fail-closed contract undocumented.** Spec 141
   established that `apps/web/src/lib/rate-limit.ts` fails CLOSED
   (Redis outage → throws → caller MUST treat as denied) but the
   contract wasn't documented at the top of the module. A new
   caller copy-pasting the example from another spec might wrap
   the call in a `.catch(() => ({ ok: true }))` shape, silently
   fail-OPENING the limit and opening a bypass vector.

## What we ship

### `apps/worker/src/log.ts` (CREATED)

A tiny structured-logger helper with three methods (`info`, `warn`,
`error`) that all emit to stderr with the format
`[worker][<iso-timestamp>][<level>] <message> <fields-json>`. The
fields argument is optional; circular references are caught and
serialised via `String(...)` so a misbehaving caller can't crash
the worker process.

### `apps/worker/src/index.ts` (EDITED)

Every prior `console.log` / `console.warn` / `console.error` call is
replaced with the matching `log.info` / `log.warn` / `log.error`
call. The bracketed sub-tags (`[retention]`, etc.) become structured
fields on the JSON payload. An inline Spec 163 comment near the top
of the file notes the contract.

### `apps/web/src/middleware.ts` (EDITED)

The stale TODO at line 3 is replaced with the up-to-date status
("spec 010 shipped; SM-1 coverage is via `recordAudit` calls inside
the API handlers; any new branch added below must explicitly
consider SM-1 coverage on the bypassed path"). Inline Spec 163
comment marks the change.

### `apps/web/src/lib/rate-limit.ts` (EDITED)

A multi-paragraph JSDoc block at the top of the module documents
the fail-closed contract with a worked example showing the correct
caller shape. Pins the literal phrase "FAIL CLOSED" so a future
contributor can't silently downgrade the contract to fail-open
without the rate-limit governance test catching the diff.

### `packages/db/src/scripts/retention.ts` (EDITED)

A new `isDirectInvocation()` helper wraps the entry-point guard.
Primary check is the existing strict path equality; fallback is a
basename comparison so symlinked invocations (pnpm workspace, container
bind mount) still auto-run when called directly. Inline Spec 163
comment notes the fallback is defensive only — the strict equality
remains the primary check.

### `apps/web/src/components/nav/Topbar.tsx` (VERIFIED, unchanged)

No hardcoded "EN" remains; the LanguagePicker island from spec 155
covers the entire language UI. The governance test pins the absence
so a future regression can't reintroduce it.

## Acceptance criteria

- `apps/worker/src/log.ts` exists and exports a `log` object with
  `info`, `warn`, `error` methods that emit to stderr with the
  `[worker][<iso-timestamp>][<level>]` prefix.
- `apps/worker/src/index.ts` contains ZERO `console.log` /
  `console.warn` / `console.error` calls — all converted to `log.*`.
- `apps/worker/src/index.ts` imports the logger from `./log.js`.
- `apps/web/src/middleware.ts` no longer contains the stale "once the
  auditing middleware lands in spec 010" phrase.
- `apps/web/src/middleware.ts` carries an inline `Spec 163` reference
  near the audit-log reminder so the cleanup is self-documenting.
- `apps/web/src/lib/rate-limit.ts` carries a JSDoc block at the top of
  the module that pins the literal "FAIL-CLOSED" phrase and shows a
  worked caller example.
- `packages/db/src/scripts/retention.ts` defines an
  `isDirectInvocation()` helper, imports `basename` from `node:path`
  and `fileURLToPath` from `node:url`, and carries an inline Spec 163
  comment explaining the fallback.
- `apps/web/src/components/nav/Topbar.tsx` contains no hardcoded `"EN"`
  literal outside of comments — the LanguagePicker island handles it.
- All five spec-kit files exist under `specs/163-nits-cleanup/`.
- `tests/governance/test_163_nits_cleanup.test.mjs` passes with at
  least 5 assertions covering the above.

## Non-goals

- **No behaviour change.** All five fixes are documentation /
  structure / format changes; no API, no DB delta, no protocol
  shift. The worker logs are now JSON-structured fields but the
  *information content* is identical.
- **No new dependencies.** The logger is a hand-rolled
  `process.stderr.write` shim; the retention fallback uses
  `node:path`/`node:url` (stdlib only).
- **No schema delta.** Next migration idx remains 0019 (assigned to
  spec 159) / 0020 (assigned to spec 161). This NIT round adds none.
- **No full-codebase console.log audit.** The worker file is the one
  flagged hot-spot; a project-wide grep would also surface intentional
  CLI scripts (`packages/db/scripts/seed.ts`, etc.) where
  `console.log` IS the user-facing output and should NOT be wrapped.
  Scope is the worker only.
- **No port of the logger to the web app.** Next.js / React Server
  Components have their own server-log routing (Vercel-style); a
  parallel helper there would just duplicate the framework's own
  output channel. Scope is the worker (a plain Node process) only.
