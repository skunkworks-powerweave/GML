# Tasks 163

- [x] T1 → write the governance test (red) covering:
  - `apps/worker/src/log.ts` exists and exports a `log` object with
    `info`, `warn`, `error` methods;
  - `apps/worker/src/index.ts` contains ZERO `console.log` /
    `console.warn` / `console.error` calls and imports the logger
    from `./log.js`;
  - `apps/web/src/middleware.ts` no longer contains the stale "once
    the auditing middleware lands in spec 010" phrase and carries a
    Spec 163 reference;
  - `apps/web/src/lib/rate-limit.ts` carries a JSDoc block at the top
    of the module pinning the literal "FAIL-CLOSED" phrase;
  - `packages/db/src/scripts/retention.ts` defines an
    `isDirectInvocation()` helper, imports `basename` from
    `node:path`, and references Spec 163;
  - `apps/web/src/components/nav/Topbar.tsx` contains no hardcoded
    `"EN"` literal outside comments.
  Run suite → red.
- [x] T2 → create `apps/worker/src/log.ts` with the structured
  logger shim (info / warn / error → stderr with bracketed prefix).
  Inline Spec 163 header comment explaining the shim's purpose
  and the format spec.
  Run scoped governance test → logger-creation assertion green.
- [x] T3 → edit `apps/worker/src/index.ts`: import `log` from
  `./log.js`, replace every `console.log` / `console.warn` /
  `console.error` call with the matching `log.*` call, lift inline
  bracket tags (`[retention]`) into structured fields. Inline Spec
  163 comment near the top of the file.
  Run scoped governance test → worker-index assertions green.
- [x] T4 → edit `apps/web/src/middleware.ts`: replace the stale
  "once the auditing middleware lands in spec 010" comment with the
  up-to-date status pointing readers at `recordAudit` calls in the
  API handlers. Inline Spec 163 reference.
  Run scoped governance test → middleware assertion green.
- [x] T5 → edit `apps/web/src/lib/rate-limit.ts`: add a multi-
  paragraph JSDoc block at the top of the module documenting the
  FAIL-CLOSED contract with a worked caller example. Pin the
  literal phrase "FAIL-CLOSED".
  Run scoped governance test → rate-limit-JSDoc assertion green.
- [x] T6 → edit `packages/db/src/scripts/retention.ts`: add
  `isDirectInvocation()` helper with the basename fallback. Import
  `basename` from `node:path` and `fileURLToPath` from `node:url`.
  Inline Spec 163 comment.
  Run scoped governance test → retention-guard assertion green.
- [x] T7 → author all five spec-kit files under
  `specs/163-nits-cleanup/`.
- [x] T8 → run the full governance suite. Confirm no regression —
  all five fixes are internal to comments, logger structure, and
  JSDoc; no other governance test reaches into the modified lines.
- [ ] T9 (future, out of scope) → port the `log` helper into the
  Next.js app's API handlers. The Next.js server has its own log
  routing (the framework's stdout / stderr is captured by the
  hosting platform), so a parallel logger there would just
  duplicate the platform's output channel. Revisit if the project
  ever decentralises the API handler logging (currently each
  handler uses ad-hoc `console.error` for failures — fine for now
  because errors flow through `recordAudit` for the audit trail
  anyway).
- [ ] T10 (future, out of scope) → upgrade the retention entry-point
  guard from basename comparison to `fs.realpathSync` if a future
  spec ever ships a second `retention.ts` elsewhere in the
  monorepo. Currently no such collision exists; the basename
  fallback is sufficient and free.
- [ ] T11 (future, out of scope) → write a `pino`-shaped abstraction
  over the worker `log` helper so a future migration to pino is a
  drop-in. Out of scope here because the surface is three
  functions; a wrapper layer would be more code than the helper
  itself.
